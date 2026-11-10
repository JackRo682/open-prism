import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import ts from 'typescript';

const directory = new URL('../.sites-runtime/security-operations-tests/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const name of ['schedule-runner', 'security-monitoring']) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8');
  await writeFile(new URL(`${name}.mjs`, directory), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}
const { runnerReady, authenticateRunner, allowRunnerInvocation } = await import(new URL('schedule-runner.mjs', directory));
const { securityRoute, classifySecurityResponse, recordSecurityEvent, securityOverview, acknowledgeSecurityAlert, trackProviderAttempt, recordGenerationOutcome } =
  await import(new URL('security-monitoring.mjs', directory));
const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url)))
  .filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')));
const now = Date.parse('2026-11-10T00:00:00Z');
const currentSecret = 'current-secret-fixture-'.repeat(3);
const previousSecret = 'previous-secret-fixture-'.repeat(3);
const activeEnv = () => ({ SCHEDULE_RUNNER_ENABLED: 'true', SCHEDULE_RUNNER_SECRET: currentSecret });
const request = (header) => new Request('https://prism.test/api/tasks/run-due', {
  method: 'POST', headers: header === undefined ? {} : { Authorization: header },
});
function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  for (const migration of migrations) database.exec(migration);
  const logs = [];
  const warn = console.warn, error = console.error, info = console.info;
  console.warn = (...values) => logs.push({ level: 'warn', values });
  console.error = (...values) => logs.push({ level: 'error', values });
  console.info = (...values) => logs.push({ level: 'info', values });
  function prepare(query) {
    let values = [];
    const statement = {
      bind(...parameters) { values = parameters; return statement; },
      async first() { return database.prepare(query).get(...values) || null; },
      async all() { return { results: database.prepare(query).all(...values) }; },
      _run() { const result = database.prepare(query).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      async run() { return statement._run(); },
    };
    return statement;
  }
  const sql = { prepare, async batch(statements) {
    database.exec('BEGIN');
    try { const results = statements.map(statement => statement._run()); database.exec('COMMIT'); return results; }
    catch (failure) { database.exec('ROLLBACK'); throw failure; }
  } };
  return { database, sql, logs, close() { database.close(); console.warn = warn; console.error = error; console.info = info; } };
}
const event = (category = 'authentication_failed', extra = {}) => ({ category, route: '/api/auth', requestId: 'request-123', status: 401, ...extra });

test('runner requires enabled valid current credentials; wrong/missing/oversized headers fail closed', async () => {
  for (const env of [{}, { SCHEDULE_RUNNER_SECRET: currentSecret }, { ...activeEnv(), SCHEDULE_RUNNER_ENABLED: 'false' },
    { ...activeEnv(), SCHEDULE_RUNNER_SECRET: '' }, { ...activeEnv(), SCHEDULE_RUNNER_SECRET: 'a'.repeat(31) },
    { ...activeEnv(), SCHEDULE_RUNNER_SECRET: 'a'.repeat(513) }, { ...activeEnv(), SCHEDULE_RUNNER_SECRET: 'x'.repeat(31)+' ' },
    { ...activeEnv(), SCHEDULE_RUNNER_SECRET: '가'.repeat(32) }, { ...activeEnv(), SCHEDULE_RUNNER_SECRET: 'x'.repeat(31)+'\n' }]) {
    assert.equal(runnerReady(env,now),false);
    assert.equal(await authenticateRunner(request('Bearer '+currentSecret),env,now),null);
  }
  assert.equal(runnerReady(activeEnv(),now),true);
  for (const header of [undefined,'','Basic '+currentSecret,'Bearer wrong','Bearer  '+currentSecret,
    'Bearer '+'a'.repeat(513),'Bearer '+currentSecret+', Bearer '+previousSecret,'Bearer '+'wrong-secret-'.repeat(5)]) {
    assert.equal(await authenticateRunner(request(header),activeEnv(),now),null, String(header));
  }
  assert.equal(await authenticateRunner(request('Bearer '+currentSecret),activeEnv(),now),'current');
  for (const size of [32,512]) {
    const secret='s'.repeat(size), env={...activeEnv(),SCHEDULE_RUNNER_SECRET:secret};
    assert.equal(await authenticateRunner(request('Bearer '+secret),env,now),'current');
  }
});

test('runner current expiry rejects exact/past and malformed dates; absence preserves existing configuration', async () => {
  for (const expiry of ['', 'not-a-date', String(now+1000), '2026-11-10', '2026-11-10T00:00:01+00:00',
    '2026-13-10T00:00:01Z', new Date(now).toISOString(), new Date(now-1).toISOString()]) {
    const env={...activeEnv(),SCHEDULE_RUNNER_SECRET_EXPIRES_AT:expiry};
    assert.equal(runnerReady(env,now),false,expiry);
    assert.equal(await authenticateRunner(request('Bearer '+currentSecret),env,now),null);
  }
  for (const expiry of [new Date(now+1).toISOString(), '2026-11-10T00:00:01Z']) {
    const env={...activeEnv(),SCHEDULE_RUNNER_SECRET_EXPIRES_AT:expiry};
    assert.equal(runnerReady(env,now),true);
    assert.equal(await authenticateRunner(request('Bearer '+currentSecret),env,now),'current');
  }
  const malformed={...activeEnv(),SCHEDULE_RUNNER_SECRET_EXPIRES_AT:'2026-02-30T00:00:00Z'};
  assert.equal(runnerReady(malformed,Date.parse('2026-02-28T00:00:00Z')),false,'impossible calendar dates must not normalize into a future expiry');
  assert.equal(runnerReady(activeEnv(),now),true);
});

test('previous runner secret works only during an explicit maximum one-day overlap and can be revoked', async () => {
  const base={...activeEnv(),SCHEDULE_RUNNER_PREVIOUS_SECRET:previousSecret};
  assert.equal(await authenticateRunner(request('Bearer '+previousSecret),base,now),null);
  for (const expiry of ['not-a-date',new Date(now-1).toISOString(),new Date(now).toISOString(),new Date(now+86400001).toISOString()]) {
    assert.equal(await authenticateRunner(request('Bearer '+previousSecret),{...base,SCHEDULE_RUNNER_PREVIOUS_SECRET_EXPIRES_AT:expiry},now),null);
  }
  for (const expiry of [new Date(now+1).toISOString(),new Date(now+86400000).toISOString()]) {
    const env={...base,SCHEDULE_RUNNER_PREVIOUS_SECRET_EXPIRES_AT:expiry};
    assert.equal(await authenticateRunner(request('Bearer '+previousSecret),env,now),'previous');
    assert.equal(await authenticateRunner(request('Bearer '+currentSecret),env,now),'current');
    assert.equal(await authenticateRunner(request('Bearer '+previousSecret),env,Date.parse(expiry)),null);
    assert.equal(await authenticateRunner(request('Bearer '+previousSecret),{...env,SCHEDULE_RUNNER_PREVIOUS_SECRET:undefined},now),null);
    assert.equal(await authenticateRunner(request('Bearer '+previousSecret),{...env,SCHEDULE_RUNNER_SECRET_EXPIRES_AT:new Date(now).toISOString()},now),null);
  }
});

test('runner invocation rate limit is atomic and opens only at the expiry boundary', async () => {
  const f=fixture();
  try {
    const results=await Promise.all(Array.from({length:12},()=>allowRunnerInvocation(f.sql,now)));
    assert.equal(results.filter(Boolean).length,1);
    assert.equal(await allowRunnerInvocation(f.sql,now+59999),false);
    assert.equal(await allowRunnerInvocation(f.sql,now+60000),true);
    assert.equal(await allowRunnerInvocation(f.sql,now+60000),false);
    const row=f.database.prepare("SELECT key,count,expires_at FROM rate_limits WHERE key='schedule-runner:invoke'").get();
    assert.equal(row.count,1); assert.equal(row.expires_at,now+120000);
  } finally { f.close(); }
});

test('route labels and response classification exclude URL identifiers, queries and file names', () => {
  for (const [input,expected] of [
    ['/api/tasks/run-due','/api/tasks/run-due'], ['/api/payments/webhook','/api/payments/webhook'],
    ['/api/account/data','/api/account/data'], ['/api/media/reference','/api/media/reference'],
    ['/api/files/private-user-document.txt','/api/files'], ['/api/conversations/private-conversation-id','/api/conversations'],
    ['/api/not-an-allowlisted-route/secret','/api/other'], ['/private/user@example.com','/other'],
  ]) assert.equal(securityRoute(input),expected);
  const classify=(path,status,duration=1)=>classifySecurityResponse(new Request('https://prism.test'+path),new Response(null,{status}),'request-safe',duration);
  assert.equal(classify('/api/chat?email=private@example.com',401).category,'authentication_failed');
  assert.equal(classify('/api/admin/private-identifier',403).category,'access_denied');
  assert.equal(classify('/api/chat',429).category,'rate_limit');
  assert.equal(classify('/api/files/private.exe',413).category,'upload_rejected');
  assert.equal(classify('/api/media/reference',415).category,'upload_rejected');
  assert.equal(classify('/api/payments/confirm',409).category,'payment_anomaly');
  assert.equal(classify('/api/chat',500).category,'server_error');
  assert.equal(classify('/api/chat',503),null);
  assert.equal(classify('/api/chat',200,119999),null);
  assert.equal(classify('/api/chat',200,120000).category,'slow_request');
  assert.deepEqual(classify('/api/files/private.exe?token=secret',413),{category:'upload_rejected',route:'/api/files',requestId:'request-safe',status:413});
});

test('alert thresholds, five-minute deduplication and acknowledgment survive further events', async () => {
  const f=fixture();
  try {
    for(let i=0;i<9;i++)await recordSecurityEvent(f.sql,event(),now+i);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM security_alerts').get().n,0);
    await recordSecurityEvent(f.sql,event(),now+9);
    let alert=f.database.prepare('SELECT * FROM security_alerts').get();
    assert.equal(alert.event_count,10); assert.equal(alert.state,'open'); assert.equal(alert.severity,'warning');
    assert.equal(await acknowledgeSecurityAlert(f.sql,alert.id,now+10),true);
    await recordSecurityEvent(f.sql,event('authentication_failed',{requestId:'later-request'}),now+11);
    alert=f.database.prepare('SELECT * FROM security_alerts').get();
    assert.equal(alert.event_count,11); assert.equal(alert.state,'acknowledged'); assert.equal(alert.acknowledged_at,now+10);
    assert.equal(alert.last_request_id,'later-request');
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM security_alerts').get().n,1);
    for(let i=0;i<10;i++)await recordSecurityEvent(f.sql,event(),now+300000+i);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM security_alerts').get().n,2);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM security_alerts WHERE state='open'").get().n,1);
    await recordSecurityEvent(f.sql,event('payment_anomaly',{route:'/api/payments/confirm',status:409}),now+300100);
    const payment=f.database.prepare("SELECT * FROM security_alerts WHERE category='payment_anomaly'").get();
    assert.equal(payment.event_count,1); assert.equal(payment.severity,'high');
    for(const invalid of [undefined,{},1,'','a'.repeat(201),'secret?email@example.com',"'; DROP TABLE security_alerts; --",'nonexistent']) {
      assert.equal(await acknowledgeSecurityAlert(f.sql,invalid,now+300200),false);
    }
  } finally { f.close(); }
});

test('all monitoring categories use their declared thresholds without retaining unsafe metadata', async () => {
  const f=fixture();
  try {
    const thresholds={authentication_failed:10,access_denied:5,rate_limit:10,upload_rejected:5,payment_anomaly:1,server_error:3,runner_failure:1,slow_request:3,resource_spike:50,deletion_retry:3,admin_adjustment:1};
    for(const [category,count] of Object.entries(thresholds)) {
      for(let i=0;i<count;i++)await recordSecurityEvent(f.sql,event(category,{route:'/api/other/secret/file.txt',requestId:'private?email@example.com',status:Infinity}),now+i);
    }
    const alerts=f.database.prepare('SELECT * FROM security_alerts').all();
    assert.equal(alerts.length,11);
    for(const alert of alerts) { assert.equal(alert.event_count,thresholds[alert.category]); assert.equal(alert.route,'/api/other'); assert.equal(alert.last_request_id,'unavailable'); assert.equal(alert.last_status,500); }
    const persisted=JSON.stringify(alerts)+JSON.stringify(f.database.prepare('SELECT * FROM security_event_windows').all())+JSON.stringify(f.logs);
    assert.doesNotMatch(persisted,/file\.txt|email@example|private\?|\/secret/);
    await recordSecurityEvent(f.sql,event('unknown-category'),now);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM security_alerts').get().n,11);
  } finally { f.close(); }
});

test('monitoring storage failures are contained and logs cannot expose database exception contents', async () => {
  const f=fixture();
  try {
    await recordSecurityEvent(undefined,event('runner_failure'),now);
    assert.equal(f.logs.filter(log=>log.level==='warn').length,1);
    const unavailable={prepare(){throw new Error('private database credentials fixture');}};
    await recordSecurityEvent(unavailable,event('runner_failure'),now);
    const error=f.logs.find(log=>log.level==='error');
    assert.ok(error); assert.match(error.values[0],/security_monitoring_unavailable/);
    assert.doesNotMatch(JSON.stringify(f.logs),/database credentials/);
  } finally { f.close(); }
});

test('provider attempts share one 50-per-five-minute counter and normal activity is informational', async () => {
  const f=fixture(), realNow=Date.now;
  Date.now=()=>now;
  try {
    let started=0;
    for(let i=0;i<49;i++) {
      assert.equal(await trackProviderAttempt(f.sql,'request-'+i,async()=>{
        started++;
        assert.equal(f.database.prepare("SELECT COALESCE(SUM(event_count),0) n FROM security_event_windows WHERE category='resource_spike'").get().n,i,'dispatch precedes monitoring');
        return 'provider-result';
      }),'provider-result');
    }
    assert.equal(started,49);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM security_alerts').get().n,0);
    const providerFailure=new Error('private upstream failure');
    await assert.rejects(trackProviderAttempt(f.sql,'request-50',async()=>{throw providerFailure;}),error=>error===providerFailure);
    const alert=f.database.prepare('SELECT * FROM security_alerts').get();
    assert.equal(alert.category,'resource_spike'); assert.equal(alert.route,'/api/generation'); assert.equal(alert.event_count,50);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM security_event_windows').get().n,1);
    assert.equal(f.logs.filter(log=>log.level==='warn').length,0);
    assert.equal(f.logs.filter(log=>log.level==='info').length,50);
    assert.doesNotMatch(JSON.stringify(f.logs),/private upstream/);
    Date.now=()=>now+300000;
    await trackProviderAttempt(f.sql,'new-window',async()=>true);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM security_event_windows').get().n,2);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM security_alerts').get().n,1);
    assert.equal(await trackProviderAttempt({prepare(){throw new Error('private database failure');}},'db-unavailable',async()=>42),42);
    assert.doesNotMatch(JSON.stringify(f.logs),/private database/);
  } finally { Date.now=realNow; f.close(); }
});

test('completed generation timing covers the exact slow boundary and distinguishes failures from controlled outcomes', async () => {
  const f=fixture();
  const outcome=(status=200)=>({route:'/api/chat',requestId:'stream-request',status,startedAt:now});
  try {
    await recordGenerationOutcome(f.sql,outcome(),now+119999);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM security_event_windows').get().n,0);
    await recordGenerationOutcome(f.sql,outcome(),now+120000);
    assert.equal(f.database.prepare("SELECT event_count FROM security_event_windows WHERE category='slow_request'").get().event_count,1);
    for(const status of [400,408,409,429,499])await recordGenerationOutcome(f.sql,outcome(status),now+1);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM security_event_windows WHERE category='server_error'").get().n,0);
    for(const status of [500,502,504])await recordGenerationOutcome(f.sql,outcome(status),now+120001);
    const counts=Object.fromEntries(f.database.prepare('SELECT category,SUM(event_count) n FROM security_event_windows GROUP BY category').all().map(row=>[row.category,row.n]));
    assert.deepEqual(counts,{server_error:3,slow_request:4});
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM security_alerts').get().n,2,'a slow provider failure contributes to each independent signal');
  } finally { f.close(); }
});

test('security overview enforces retention cutoffs and counts only the last hour of activity', async () => {
  const f=fixture();
  try {
    const day=86400000;
    // Build age boundaries directly, independent of any future ingestion cleanup.
    const insertWindow=(key,when,count=1)=>f.database.prepare('INSERT INTO security_event_windows (key,category,route,event_count,window_start,last_seen,last_request_id,last_status) VALUES (?,\'rate_limit\',\'/api/chat\',?,?,?,\'safe\',429)').run(key,count,when,when);
    const insertAlert=(id,when)=>f.database.prepare("INSERT INTO security_alerts (id,category,route,severity,event_count,first_seen,last_seen,last_request_id,last_status,state) VALUES (?,'runner_failure','/api/tasks/run-due','high',1,?,?,'safe',500,'open')").run(id,when,when);
    insertWindow('expired-window',now-day-1,2); insertWindow('boundary-window',now-day,3);
    insertWindow('older-than-hour',now-3600001,7); insertWindow('hour-boundary',now-3600000,5); insertWindow('current-window',now,4);
    insertAlert('expired-alert',now-30*day-1); insertAlert('boundary-alert',now-30*day); insertAlert('current-alert',now);
    const insertUsage=f.database.prepare('INSERT INTO usage (id,user_id,model,provider,status,created_at) VALUES (?,\'alice\',\'model\',\'provider\',?,?)');
    insertUsage.run('old','complete',now-3600001);insertUsage.run('pending','pending',now);insertUsage.run('error','error',now);insertUsage.run('complete','complete',now-3600000);
    const overview=await securityOverview(f.sql,now);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM security_event_windows WHERE key='expired-window'").get().n,0);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM security_event_windows WHERE key='boundary-window'").get().n,1);
    assert.deepEqual(overview.alerts.map(item=>item.id),['current-alert','boundary-alert']);
    assert.deepEqual(overview.lastHour.map(item=>({...item})),[{category:'rate_limit',events:9}]);
    assert.deepEqual({...overview.usage},{requests:3,pending:1,failed:1});
    assert.equal(overview.eventRetentionDays,1);assert.equal(overview.alertRetentionDays,30);
    assert.deepEqual(overview.delivery,{database:true,structuredWorkerLogs:true,externalNotifications:false});
  } finally { f.close(); }
});

test('unrecognized and inherited category names are discarded before logging or database access', async () => {
  const f=fixture();
  try {
    for(const category of ['unknown-category','constructor','__proto__','toString']) {
      await recordSecurityEvent(f.sql,event(category),now);
    }
    assert.deepEqual(f.logs,[]);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM security_event_windows').get().n,0);
  } finally { f.close(); }
});

test('event ingestion prunes old records once per hour without requiring an admin overview request', async () => {
  const f=fixture();
  try {
    const seedOld=(suffix)=>{
      f.database.prepare("INSERT INTO security_event_windows (key,category,route,event_count,window_start,last_seen,last_request_id,last_status) VALUES (?,'rate_limit','/api/chat',1,?,?,'safe',429)")
        .run('old-window-'+suffix,now-86400001,now-86400001);
      f.database.prepare("INSERT INTO security_alerts (id,category,route,severity,event_count,first_seen,last_seen,last_request_id,last_status,state) VALUES (?,'runner_failure','/api/tasks/run-due','high',1,?,?,'safe',500,'open')")
        .run('old-alert-'+suffix,now-30*86400000-1,now-30*86400000-1);
    };
    seedOld('first');
    await recordSecurityEvent(f.sql,event('runner_failure'),now);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM security_event_windows WHERE key='old-window-first'").get().n,0);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM security_alerts WHERE id='old-alert-first'").get().n,0);
    const throttle=f.database.prepare("SELECT expires_at FROM rate_limits WHERE key='security:retention'").get();
    assert.equal(throttle.expires_at,now+3600000);
    seedOld('next');
    await recordSecurityEvent(f.sql,event('runner_failure'),now+3599999);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM security_event_windows WHERE key='old-window-next'").get().n,1);
    await recordSecurityEvent(f.sql,event('runner_failure'),now+3600000);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM security_event_windows WHERE key='old-window-next'").get().n,0);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM security_alerts WHERE id='old-alert-next'").get().n,0);
  } finally { f.close(); }
});

test('security event counters saturate without creating duplicate alerts', async () => {
  const f=fixture();
  try {
    await recordSecurityEvent(f.sql,event('payment_anomaly'),now);
    f.database.prepare('UPDATE security_event_windows SET event_count=999999').run();
    await recordSecurityEvent(f.sql,event('payment_anomaly'),now+1);
    await recordSecurityEvent(f.sql,event('payment_anomaly'),now+2);
    assert.equal(f.database.prepare('SELECT event_count FROM security_event_windows').get().event_count,1000000);
    assert.equal(f.database.prepare('SELECT event_count FROM security_alerts').get().event_count,1000000);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM security_alerts').get().n,1);
  } finally { f.close(); }
});
