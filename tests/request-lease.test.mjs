import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import ts from 'typescript';

const directory=new URL('../.sites-runtime/request-lease-tests/',import.meta.url);
await mkdir(directory,{recursive:true});
const source=await readFile(new URL('../lib/request-lease.ts',import.meta.url),'utf8');
await writeFile(new URL('request-lease.mjs',directory),ts.transpileModule(source,{
  compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
}).outputText);
const {acquireRequestLease,releaseRequestLease,requestLeaseIsCurrent,requestLeaseFence}=await import(new URL('request-lease.mjs',directory));
const migrations=await Promise.all((await readdir(new URL('../drizzle/',import.meta.url)))
  .filter(name=>name.endsWith('.sql')).sort().map(name=>readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')));
function fixture(){
  const database=new DatabaseSync(':memory:');database.exec('PRAGMA foreign_keys=ON');
  for(const migration of migrations)database.exec(migration);
  const sql={prepare(query){let values=[];const statement={
    bind(...parameters){values=parameters;return statement;},
    async first(){return database.prepare(query).get(...values)||null;},
    async all(){return {results:database.prepare(query).all(...values)};},
    _run(){const result=database.prepare(query).run(...values);return {success:true,meta:{changes:Number(result.changes)}};},
    async run(){return statement._run();},
  };return statement;},async batch(statements){
    database.exec('BEGIN');
    try{const result=statements.map(statement=>statement._run());database.exec('COMMIT');return result;}
    catch(error){database.exec('ROLLBACK');throw error;}
  }};
  return {database,sql,close(){database.close();}};
}
const now=Date.parse('2026-11-10T00:00:00Z');

test('concurrent same-key lease attempts produce exactly one owner and unrelated keys remain independent',async()=>{
  const f=fixture();
  try{
    const attempts=await Promise.all(Array.from({length:20},()=>acquireRequestLease(f.sql,'chat:one',60000,now)));
    const owners=attempts.filter(Boolean);assert.equal(owners.length,1);
    assert.equal(await requestLeaseIsCurrent(f.sql,owners[0],now),true);
    const other=await acquireRequestLease(f.sql,'chat:two',60000,now);assert.ok(other);
    assert.notEqual(other.token,owners[0].token);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM rate_limits').get().n,2);
    await releaseRequestLease(f.sql,owners[0]);
    assert.equal(await requestLeaseIsCurrent(f.sql,owners[0],now),false);
    assert.equal(await requestLeaseIsCurrent(f.sql,other,now),true);
  }finally{f.close();}
});

test('expiry boundary permits takeover and a delayed former owner cannot release the replacement',async()=>{
  const f=fixture();
  try{
    const old=await acquireRequestLease(f.sql,'media-poll:one',1000,now);assert.ok(old);
    assert.equal(await acquireRequestLease(f.sql,old.key,1000,now+999),null);
    assert.equal(await requestLeaseIsCurrent(f.sql,old,now+999),true);
    assert.equal(await requestLeaseIsCurrent(f.sql,old,now+1000),false);
    const replacement=await acquireRequestLease(f.sql,old.key,1000,now+1000);assert.ok(replacement);
    assert.notEqual(old.token,replacement.token);
    await releaseRequestLease(f.sql,old);
    assert.equal(await requestLeaseIsCurrent(f.sql,replacement,now+1000),true);
    const stored=f.database.prepare('SELECT lease_token,expires_at FROM rate_limits WHERE key=?').get(old.key);
    assert.equal(stored.lease_token,replacement.token);assert.equal(stored.expires_at,now+2000);
    await releaseRequestLease(f.sql,replacement);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM rate_limits').get().n,0);
  }finally{f.close();}
});

test('reacquisition at the same clock and identical expiry is protected by its unique token',async()=>{
  const f=fixture();
  try{
    const first=await acquireRequestLease(f.sql,'chat:same-expiry',250000,now);assert.ok(first);
    await releaseRequestLease(f.sql,first);
    const second=await acquireRequestLease(f.sql,first.key,250000,now);assert.ok(second);
    assert.equal(first.expiresAt,second.expiresAt);assert.notEqual(first.token,second.token);
    await releaseRequestLease(f.sql,first);
    await releaseRequestLease(f.sql,{...second,token:crypto.randomUUID()});
    assert.equal(await requestLeaseIsCurrent(f.sql,first,now),false);
    assert.equal(await requestLeaseIsCurrent(f.sql,second,now),true);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM rate_limits').get().n,1);
  }finally{f.close();}
});

test('expired rows removed by housekeeping cannot let stale cleanup delete a reacquired lease',async()=>{
  const f=fixture();
  try{
    const old=await acquireRequestLease(f.sql,'browser:user',1000,now);assert.ok(old);
    f.database.prepare('DELETE FROM rate_limits WHERE expires_at<?').run(now+1001);
    const current=await acquireRequestLease(f.sql,old.key,1000,now+1001);assert.ok(current);
    await releaseRequestLease(f.sql,old);
    assert.equal(await requestLeaseIsCurrent(f.sql,current,now+1001),true);
  }finally{f.close();}
});

test('legacy lock rows block acquisition until expiry and are upgraded to token ownership on takeover',async()=>{
  const f=fixture();
  try{
    f.database.prepare('INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?)').run('chat:legacy',now+1000);
    assert.equal(await acquireRequestLease(f.sql,'chat:legacy',60000,now),null);
    const current=await acquireRequestLease(f.sql,'chat:legacy',60000,now+1000);assert.ok(current);
    assert.equal(typeof current.token,'string');assert.equal(await requestLeaseIsCurrent(f.sql,current,now+1000),true);
    await releaseRequestLease(f.sql,{...current,token:''});
    assert.equal(await requestLeaseIsCurrent(f.sql,current,now+1000),true);
  }finally{f.close();}
});

test('invalid lease keys and durations never allocate a row',async()=>{
  const f=fixture();
  try{
    for(const [key,duration] of [['',1000],['a'.repeat(301),1000],['valid',0],['valid',-1],['valid',1.5],['valid',NaN],['valid',Infinity],['valid',900001]]){
      await assert.rejects(()=>acquireRequestLease(f.sql,key,duration,now),/Invalid request lease/);
    }
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM rate_limits').get().n,0);
  }finally{f.close();}
});

test('a valid fence protects a transaction without extending or replacing the lease',async()=>{
  const f=fixture();
  try{
    f.database.exec('CREATE TABLE lease_probe (value TEXT NOT NULL)');
    const lease=await acquireRequestLease(f.sql,'chat:fenced',1000,now);assert.ok(lease);
    await f.sql.batch([requestLeaseFence(f.sql,lease,now+1),f.sql.prepare('INSERT INTO lease_probe VALUES (?)').bind('protected')]);
    assert.deepEqual(f.database.prepare('SELECT value FROM lease_probe').all().map(row=>row.value),['protected']);
    const stored=f.database.prepare('SELECT count,expires_at,lease_token FROM rate_limits WHERE key=?').get(lease.key);
    assert.equal(stored.count,1);assert.equal(stored.expires_at,lease.expiresAt);assert.equal(stored.lease_token,lease.token);
  }finally{f.close();}
});

test('stale, expired, or missing lease fences roll back every write in a batch',async()=>{
  for(const state of ['reacquired','expired','missing']){
    const f=fixture();
    try{
      f.database.exec('CREATE TABLE lease_probe (value TEXT NOT NULL)');
      const old=await acquireRequestLease(f.sql,'chat:protected',1000,now);assert.ok(old);
      let current;
      if(state==='reacquired'){
        await releaseRequestLease(f.sql,old);
        current=await acquireRequestLease(f.sql,old.key,1000,now);assert.ok(current);
        assert.equal(current.expiresAt,old.expiresAt);
      }else if(state==='missing')await releaseRequestLease(f.sql,old);
      const checkAt=state==='expired'?now+1000:now+1;
      const before=f.database.prepare('SELECT * FROM rate_limits ORDER BY key').all();
      // The production fence is first. Including a write before it here also
      // proves transaction rollback, rather than only skipping later writes.
      await assert.rejects(()=>f.sql.batch([
        f.sql.prepare('INSERT INTO lease_probe VALUES (?)').bind('before-guard'),
        requestLeaseFence(f.sql,old,checkAt),
        f.sql.prepare('INSERT INTO lease_probe VALUES (?)').bind('after-guard'),
      ]),/NOT NULL constraint failed: rate_limits.count/);
      assert.deepEqual(f.database.prepare('SELECT value FROM lease_probe').all(),[]);
      assert.deepEqual(f.database.prepare('SELECT * FROM rate_limits ORDER BY key').all(),before);
      if(current)assert.equal(await requestLeaseIsCurrent(f.sql,current,now+1),true);
      if(state==='missing')assert.equal(f.database.prepare('SELECT COUNT(*) n FROM rate_limits').get().n,0);
    }finally{f.close();}
  }
});
