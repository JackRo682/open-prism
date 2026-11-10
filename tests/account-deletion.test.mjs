import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const runtime=new URL('../.sites-runtime/account-deletion-tests/',import.meta.url);
await mkdir(runtime,{recursive:true});
await writeFile(new URL('account-deletion.mjs',runtime),ts.transpileModule(await readFile(new URL('../lib/account-deletion.ts',import.meta.url),'utf8'),{
 compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
}).outputText);
const {AccountDeletionError,assertAccountAvailable,beginAccountOperation,endAccountOperation,requestAccountDeletion,getAccountDeletionStatus,resumePendingAccountDeletions,WORKSPACE_CONTENT_TABLES,DELETION_AUDIT_RETENTION_MS}=await import(new URL('account-deletion.mjs',runtime));
const migrations=await Promise.all((await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort().map(name=>readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')));

function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON;');
 for(const migration of migrations)sqlite.exec(migration);
 const objects=new Map(),deleted=[],listed=[],control={deleteError:false,listError:false,failQuery:null,beforeDelete:null};
 const execute=(query,params,mode)=>{
  if(control.failQuery&&query.includes(control.failQuery))throw new Error('Sensitive database diagnostics');
  const statement=sqlite.prepare(query);
  if(mode==='first')return statement.get(...params)||null;
  if(mode==='all')return {success:true,results:statement.all(...params),meta:{changes:0}};
  const returns=statement.columns().length>0;
  const results=returns?statement.all(...params):[];
  const changes=returns?sqlite.prepare('SELECT changes() AS n').get().n:statement.run(...params).changes;
  return {success:true,results,meta:{changes:Number(changes)}};
 };
 const sql={prepare(query){let params=[];return {bind(...values){params=values;return this;},async first(){return execute(query,params,'first');},async all(){return execute(query,params,'all');},async run(){return execute(query,params,'run');}};},async batch(statements){
  sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}
 }};
 const bucket={async delete(keys){const batch=Array.isArray(keys)?keys:[keys];await control.beforeDelete?.(batch);if(control.deleteError)throw new Error('secret storage key and provider detail');for(const key of batch){objects.delete(key);deleted.push(key);}},async list({prefix,limit=1000}){
  listed.push(prefix);if(control.listError)throw new Error('secret bucket diagnostics');
  const keys=[...objects.keys()].filter(key=>key.startsWith(prefix)).sort();return {objects:keys.slice(0,limit).map(key=>({key})),truncated:keys.length>limit};
 }};
 function seed(owner){
  const id=owner+'-conversation',usageId=owner+'-usage';
  sqlite.prepare('INSERT INTO usage (id,user_id,model,provider,status,error,created_at,reserved_amount) VALUES (?,?,?,?,?,?,?,?)').run(usageId,owner,'gpt-6.1-sol','openai','error','Personal document or upstream diagnostic',1,1234);
  sqlite.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id,owner,'Private title','gpt-6.1-sol',1,1);
  sqlite.prepare('INSERT INTO messages (id,conversation_id,role,content,created_at,usage_id) VALUES (?,?,?,?,?,?)').run(owner+'-message',id,'user','Private message',1,usageId);
  sqlite.prepare('INSERT INTO message_feedback (message_id,user_id,rating,details,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(owner+'-message',owner,'up','Private feedback',1,1);
  sqlite.prepare('INSERT INTO conversation_revisions (id,conversation_id,user_id,action,target_message_id,created_at) VALUES (?,?,?,?,?,?)').run(owner+'-revision',id,owner,'edit',owner+'-message',1);
  sqlite.prepare('INSERT INTO conversation_revision_messages (revision_id,message_id,original_order,role,content,created_at,usage_id) VALUES (?,?,?,?,?,?,?)').run(owner+'-revision',owner+'-old-message',0,'user','Original private message',1,usageId);
  sqlite.prepare('INSERT INTO conversation_reports (id,user_id,request_id,conversation_id,message_id,category,details,snapshot,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(owner+'-report',owner,owner+'-report-request',id,owner+'-message','privacy','Private report','Private snapshot',1,1);
  sqlite.prepare('INSERT INTO chat_operations (id,user_id,client_request_id,request_hash,conversation_id,action,user_message_id,assistant_message_id,status,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(owner+'-chat-operation',owner,owner+'-client-request','hash',id,'append',owner+'-message',owner+'-answer','error','Private diagnostic',1,1);
  sqlite.prepare('INSERT INTO files (id,user_id,name,key,size,type,created_at) VALUES (?,?,?,?,?,?,?)').run(owner+'-file',owner,'secret.txt',owner+'/file',6,'text/plain',1);
  sqlite.prepare('INSERT INTO media_assets (id,user_id,kind,prompt,model,status,object_key,mime_type,size,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(owner+'-media',owner,'reference','Private reference','image','complete',owner+'/references/image','image/png',6,1,1);
  sqlite.prepare('INSERT INTO work_artifacts (id,user_id,conversation_id,name,object_key,mime_type,size,created_at) VALUES (?,?,?,?,?,?,?,?)').run(owner+'-artifact',owner,id,'result.txt',owner+'/artifacts/file','application/octet-stream',6,1);
  sqlite.prepare('INSERT INTO scheduled_tasks (id,user_id,title,prompt,model,timezone,recurrence,scheduled_at,enabled,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(owner+'-task',owner,'Private task','Private prompt','gpt-6.1-sol','UTC','once',100,0,'draft',1,1);
  sqlite.prepare('INSERT INTO browser_sessions (id,user_id,url,title,content,created_at) VALUES (?,?,?,?,?,?)').run(owner+'-browser',owner,'https://example.test/private','Private browser','Private capture',1);
  sqlite.prepare('INSERT INTO public_shares (id,user_id,conversation_id,token,title,snapshot,created_at) VALUES (?,?,?,?,?,?,?)').run(owner+'-share',owner,id,owner+'-share-token','Private share','Private share contents',1);
  sqlite.prepare('INSERT INTO workspace_settings (user_id,settings,updated_at) VALUES (?,?,?)').run(owner,'Private memory and skills',1);
  sqlite.prepare('INSERT INTO auth_accounts (user_id,email,created_at,updated_at) VALUES (?,?,?,?)').run(owner,owner+'@example.test',1,1);
  sqlite.prepare('INSERT INTO auth_google_identities (google_subject,user_id,created_at) VALUES (?,?,?)').run(owner+'-google',owner,1);
  sqlite.prepare('INSERT INTO auth_sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(owner+'-session',owner,1,999999);
  sqlite.prepare('INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at) VALUES (?,?,?,?,?,?,?)').run(owner+'-wallet',owner,'live','topup',1000,owner+'-payment',1);
  sqlite.prepare('INSERT INTO payments (id,user_id,amount,mode,status,created_at) VALUES (?,?,?,?,?,?)').run(owner+'-payment',owner,1000,'live','paid',1);
  sqlite.prepare('INSERT INTO account_flags (user_id,reason,created_at) VALUES (?,?,?)').run(owner,'Accounting review',1);
  for(const key of [owner+'/file',owner+'/references/image',owner+'/artifacts/file',owner+'/orphan'])objects.set(key,'private bytes');
 }
 return {sqlite,sql,bucket,objects,deleted,listed,control,seed,close:()=>sqlite.close()};
}

test('deletion removes every content table and exact-owner storage, preserving sign-in and accounting',async()=>{
 const f=fixture();try{
  f.seed('alice');f.seed('bob');f.objects.set('alice-other/private','other account');
  const result=await requestAccountDeletion(f.sql,f.bucket,'alice');
  assert.equal(result.status,'complete');assert.equal(result.ok,true);assert.equal(result.deletedObjects,4);
  for(const row of WORKSPACE_CONTENT_TABLES){
   if(['messages','conversation_revision_messages'].includes(row.table)){assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM '+row.table).get().n,1);continue;}
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM '+row.table+' WHERE user_id=?').get('alice').n,0,row.table);
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM '+row.table+' WHERE user_id=?').get('bob').n,1,row.table);
  }
  for(const table of ['usage','wallet_events','payments','account_flags','auth_accounts','auth_google_identities','auth_sessions'])assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM '+table+' WHERE user_id=?').get('alice').n,1,table);
  assert.equal(f.sqlite.prepare('SELECT error FROM usage WHERE user_id=?').get('alice').error,null);
  assert.equal(f.sqlite.prepare('SELECT reserved_amount FROM usage WHERE user_id=?').get('alice').reserved_amount,1234);
  assert.equal(f.objects.size,5);assert.ok(f.deleted.every(key=>key.startsWith('alice/')));assert.ok(f.listed.every(prefix=>prefix==='alice/'));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_deletion_objects').get().n,0);
  await assertAccountAvailable(f.sql,'alice');const token=await beginAccountOperation(f.sql,'alice');await endAccountOperation(f.sql,token);
  f.sqlite.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('new-chat','alice','After deletion','gpt-6.1-sol',2,2);
 }finally{f.close();}
});

test('schema inventory requires an explicit deletion or retention decision for every owner table',()=>{
 const f=fixture();try{
  const classified=new Set([...WORKSPACE_CONTENT_TABLES.map(row=>row.table),'usage','wallet_events','payments','account_flags','auth_accounts','auth_google_identities','auth_sessions','account_deletion_jobs','account_data_operations']);
  for(const {name} of f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
   if(f.sqlite.prepare('PRAGMA table_info('+name+')').all().some(column=>column.name==='user_id'))assert.ok(classified.has(name),'Unclassified user-owned table: '+name);
  }
 }finally{f.close();}
});

test('a pending job blocks new operations and content writes, revokes shares, and waits for durable operations',async()=>{
 const f=fixture();try{
  f.seed('alice');f.seed('bob');const token=await beginAccountOperation(f.sql,'alice');
  let result=await requestAccountDeletion(f.sql,f.bucket,'alice',{now:1000});
  assert.equal(result.status,'pending');assert.equal(result.activeOperations,1);assert.equal(result.lastErrorCode,'WAITING_FOR_OPERATIONS');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM public_shares WHERE user_id=?').get('alice').n,0);
  assert.equal(f.objects.size,8);assert.equal(f.deleted.length,0);
  await assert.rejects(()=>assertAccountAvailable(f.sql,'alice'),error=>error instanceof AccountDeletionError&&error.status===423);
  await assert.rejects(()=>beginAccountOperation(f.sql,'alice'),/진행 중/);
  assert.throws(()=>f.sqlite.prepare('UPDATE conversations SET title=? WHERE user_id=?').run('late private title','alice'),/ACCOUNT_DELETION_PENDING/);
  assert.throws(()=>f.sqlite.prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)').run('late-message','alice-conversation','assistant','late response',1),/ACCOUNT_DELETION_PENDING/);
  assert.throws(()=>f.sqlite.prepare('UPDATE conversation_revision_messages SET content=? WHERE revision_id=?').run('late old message','alice-revision'),/ACCOUNT_DELETION_PENDING/);
  f.sqlite.prepare('UPDATE conversations SET title=? WHERE user_id=?').run('Bob still works','bob');
  await endAccountOperation(f.sql,'wrong-token');
  result=await requestAccountDeletion(f.sql,f.bucket,'alice',{now:1000+7*DELETION_AUDIT_RETENTION_MS});
  assert.equal(result.activeOperations,1,'Old tokens must not expire into a stale writer');assert.equal(result.status,'pending');
  await endAccountOperation(f.sql,token);await endAccountOperation(f.sql,token);
  result=await requestAccountDeletion(f.sql,f.bucket,'alice');assert.equal(result.status,'complete');
 }finally{f.close();}
});

test('interrupted object deletion keeps a private durable retry manifest and never reports success',async()=>{
 const f=fixture();try{
  f.seed('alice');f.control.deleteError=true;
  const failed=await requestAccountDeletion(f.sql,f.bucket,'alice');
  assert.equal(failed.status,'pending');assert.equal(failed.ok,false);assert.equal(failed.lastErrorCode,'DELETION_RETRY_REQUIRED');
  assert.equal(failed.pendingObjects,3);assert.equal(failed.deletedObjects,0);assert.equal(f.objects.size,4);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM files WHERE user_id=?').get('alice').n,1);
  assert.doesNotMatch(JSON.stringify(failed),/secret storage|provider detail|alice\//);
  f.control.deleteError=false;const result=await requestAccountDeletion(f.sql,f.bucket,'alice');
  assert.equal(result.jobId,failed.jobId);assert.equal(result.status,'complete');assert.equal(f.objects.size,0);
 }finally{f.close();}
});

test('a failure after storage cleanup rolls back database deletion and resumes from its manifest',async()=>{
 const f=fixture();try{
  f.seed('alice');f.control.failQuery='DELETE FROM browser_sessions';
  let result=await requestAccountDeletion(f.sql,f.bucket,'alice');
  assert.equal(result.status,'pending');assert.equal(result.deletedObjects,4);assert.equal(f.objects.size,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM conversation_reports WHERE user_id=?').get('alice').n,1,'Earlier statements must roll back');
  f.control.failQuery=null;result=await requestAccountDeletion(f.sql,f.bucket,'alice');
  assert.equal(result.status,'complete');assert.equal(result.deletedObjects,4);assert.equal(f.deleted.length,4,'Confirmed deletes are not repeatedly re-enqueued');
 }finally{f.close();}
});

test('unavailable storage and corrupt foreign object references fail closed',async()=>{
 const f=fixture();try{
  f.seed('alice');f.seed('bob');let result=await requestAccountDeletion(f.sql,undefined,'alice');
  assert.equal(result.status,'pending');assert.equal(result.lastErrorCode,'STORAGE_NOT_CONFIGURED');assert.equal(f.objects.size,8);
  // Simulate a corrupted historical pointer before a job starts for a separate account.
  f.sqlite.prepare('UPDATE files SET key=? WHERE user_id=?').run('bob/file','bob');
  const bobToken=await beginAccountOperation(f.sql,'bob');await endAccountOperation(f.sql,bobToken);
  // Existing data cannot be updated behind Alice's deletion barrier. Inserting
  // a bad key before Carol's request exercises the namespace check directly.
  f.sqlite.prepare('INSERT INTO files (id,user_id,name,key,size,type,created_at) VALUES (?,?,?,?,?,?,?)').run('carol-file','carol','bad.txt','bob/file',6,'text/plain',1);
  result=await requestAccountDeletion(f.sql,f.bucket,'carol');
  assert.equal(result.status,'pending');assert.equal(result.lastErrorCode,'OBJECT_OWNERSHIP_MISMATCH');assert.equal(result.retryable,false);
  assert.equal(f.objects.get('bob/file'),'private bytes');assert.equal(f.deleted.length,0);
  await assert.rejects(()=>requestAccountDeletion(f.sql,f.bucket,'alice/bob'),error=>error.code==='ACCOUNT_STORAGE_NAMESPACE_INVALID');
 }finally{f.close();}
});

test('object and row cleanup is bounded and retries do not skip remaining pages',async()=>{
 const f=fixture();try{
  f.seed('alice');for(let i=0;i<11;i++)f.objects.set('alice/extra-'+String(i).padStart(2,'0'),'bytes');
  for(let i=0;i<501;i++)f.sqlite.prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)').run('many-'+i,'alice-conversation','user','private',i+2);
  let result,iterations=0,previousDeletes=0;
  do{
   result=await requestAccountDeletion(f.sql,f.bucket,'alice',{maxObjects:2});
   assert.ok(f.deleted.length-previousDeletes<=2);previousDeletes=f.deleted.length;
   assert.ok(++iterations<20);
  }while(result.status==='pending');
  assert.equal(f.objects.size,0);assert.equal(f.deleted.length,15);assert.equal(new Set(f.deleted).size,15);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);assert.ok(iterations>=8);
 }finally{f.close();}
});

test('overlapping resumptions share one worker token and cannot double-complete',async()=>{
 const f=fixture();let release,entered;const started=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
 try{
  f.seed('alice');f.control.beforeDelete=async()=>{entered();await blocked;};
  const first=requestAccountDeletion(f.sql,f.bucket,'alice');await started;
  const overlap=await requestAccountDeletion(f.sql,f.bucket,'alice');
  assert.equal(overlap.status,'pending');assert.equal(overlap.workerRunning,true);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM account_deletion_jobs WHERE status='pending'").get().n,1);
  release();const done=await first;assert.equal(done.status,'complete');assert.equal(done.deletedObjects,4);assert.equal(f.deleted.length,4);
 }finally{release?.();f.close();}
});

test('a stranded deletion worker stays visible and never expires into a second destructive sweep',async()=>{
 const f=fixture();try{
  f.seed('alice');const operation=await beginAccountOperation(f.sql,'alice');
  const pending=await requestAccountDeletion(f.sql,f.bucket,'alice',{now:1});await endAccountOperation(f.sql,operation);
  f.sqlite.prepare('UPDATE account_deletion_jobs SET worker_token=?,worker_started_at=? WHERE id=?').run('stranded-worker',1,pending.jobId);
  const late=await requestAccountDeletion(f.sql,f.bucket,'alice',{now:10*DELETION_AUDIT_RETENTION_MS});
  assert.equal(late.status,'pending');assert.equal(late.workerRunning,true);assert.equal(f.deleted.length,0);
  assert.deepEqual(await resumePendingAccountDeletions(f.sql,f.bucket,{now:10*DELETION_AUDIT_RETENTION_MS}),[]);
  assert.equal((await getAccountDeletionStatus(f.sql,'alice')).workerRunning,true);
 }finally{f.close();}
});

test('outstanding provider reservations survive deletion without refunding or resetting quota history',async()=>{
 const f=fixture();try{
  f.seed('alice');f.sqlite.prepare("UPDATE usage SET status='pending' WHERE user_id=?").run('alice');
  const result=await requestAccountDeletion(f.sql,f.bucket,'alice');assert.equal(result.status,'complete');
  const usage=f.sqlite.prepare('SELECT status,error,reserved_amount FROM usage WHERE user_id=?').get('alice');
  assert.equal(usage.status,'error');assert.equal(usage.reserved_amount,1234);assert.equal(usage.error,'Workspace data deleted; provider usage requires reconciliation.');
  assert.equal(f.sqlite.prepare('SELECT SUM(amount) AS balance FROM wallet_events WHERE user_id=?').get('alice').balance,1000);
 }finally{f.close();}
});

test('maintenance resumes bounded pending jobs and only expires completed audit records',async()=>{
 const f=fixture();try{
  f.seed('alice');f.seed('bob');const token=await beginAccountOperation(f.sql,'bob');
  await requestAccountDeletion(f.sql,f.bucket,'alice',{now:1});await requestAccountDeletion(f.sql,f.bucket,'bob',{now:2});
  const results=await resumePendingAccountDeletions(f.sql,f.bucket,{limit:1,now:DELETION_AUDIT_RETENTION_MS+10});
  assert.equal(results.length,1);assert.equal(results[0].status,'pending');
  assert.equal(await getAccountDeletionStatus(f.sql,'alice'),null);assert.equal((await getAccountDeletionStatus(f.sql,'bob')).activeOperations,1);
  await endAccountOperation(f.sql,token);assert.equal((await resumePendingAccountDeletions(f.sql,f.bucket))[0].status,'complete');
 }finally{f.close();}
});
