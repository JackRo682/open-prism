import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { setImmediate as nextTask } from 'node:timers/promises';
import ts from 'typescript';

// Run the shipped API routes against all migrations. Auth, transport and R2
// are the only service boundaries replaced with deterministic local fixtures.
const runtime = new URL('../.sites-runtime/account-deletion-api-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
let user, sqlite, onOperationRelease, storageFailure, providerCalls;
const env = {}, objects = new Map(), objectReads = [], objectDeletes = [], logs = [];
const originalFetch = globalThis.fetch;
const originalConsole = { info: console.info, warn: console.warn, error: console.error };
globalThis.__accountDeletionApiTest = { env, getChatGPTUser: async () => user };
await writeFile(new URL('context.mjs', runtime), 'export const {env,getChatGPTUser}=globalThis.__accountDeletionApiTest;');
const modules = ['models', 'provider', 'chat-title', 'billing-contract', 'billing', 'beta', 'workspace-settings', 'workspace-tools', 'workspace-bootstrap', 'workspace-startup', 'conversation-actions', 'chat-generation', 'media-provider', 'media-workspace', 'browser-workspace', 'scheduled-tasks', 'schedule-time', 'work-artifacts', 'regenerate-style', 'guest-chat', 'guest-import', 'public-shares', 'upload-security', 'api-resource-guards', 'request-security', 'request-lease', 'schedule-runner', 'security-monitoring', 'account-deletion', 'upload-validation', 'image-validation'];
for (const [source, target] of [...modules.map(name => ['lib/' + name + '.ts', name + '.mjs']), ['app/api/[...path]/route.ts', 'route.mjs']]) {
  let code = (await readFile(new URL('../' + source, import.meta.url), 'utf8'))
    .replaceAll("'cloudflare:workers'", "'./context.mjs'")
    .replaceAll("'../../chatgpt-auth'", "'./context.mjs'");
  for (const name of modules) code = code.replaceAll("'../../../lib/" + name + "'", "'./" + name + ".mjs'").replaceAll("'./" + name + "'", "'./" + name + ".mjs'");
  await writeFile(new URL(target, runtime), ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const route = await import(new URL('route.mjs', runtime));
const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url)))
  .filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')));

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON;');
  for (const migration of migrations) sqlite.exec(migration);
  for (const name of Object.keys(env)) delete env[name];
  Object.assign(env, { BETA_MODE: 'true', OPENAI_API_KEY: 'fixture-provider-secret', GEMINI_API_KEY: 'fixture-google-secret' });
  objects.clear(); objectReads.length = 0; objectDeletes.length = 0; logs.length = 0;
  onOperationRelease = undefined; storageFailure = false; providerCalls = 0;
  user = { userId: 'alice', email: 'alice@example.test' };
  for (const method of Object.keys(originalConsole)) console[method] = (...values) => logs.push(values.map(String).join(' '));
  const execute = (query, bindings, mode) => {
    const statement = sqlite.prepare(query);
    if (mode === 'first') return statement.get(...bindings) || null;
    if (mode === 'all') return { success: true, results: statement.all(...bindings), meta: { changes: 0 } };
    const returning = statement.columns().length > 0;
    const results = returning ? statement.all(...bindings) : [];
    const changes = returning ? sqlite.prepare('SELECT changes() AS n').get().n : statement.run(...bindings).changes;
    if (/DELETE FROM account_data_operations WHERE token=\?/.test(query)) onOperationRelease?.(bindings[0]);
    return { success: true, results, meta: { changes: Number(changes) } };
  };
  env.DB = {
    prepare(query) {
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        async first() { return execute(query, bindings, 'first'); },
        async all() { return execute(query, bindings, 'all'); },
        async run() { return execute(query, bindings, 'run'); },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT'); return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  env.BUCKET = {
    async put(key, value) { objects.set(key, new Uint8Array(await new Response(value).arrayBuffer())); },
    async get(key) {
      objectReads.push(key);
      const bytes = objects.get(key); if (!bytes) return null;
      return { size: bytes.length, body: new Blob([bytes]).stream(), text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
    },
    async delete(keys) {
      if (storageFailure) throw new Error('private R2 key and fixture-provider-secret');
      for (const key of Array.isArray(keys) ? keys : [keys]) { objects.delete(key); objectDeletes.push(key); }
    },
    async list({ prefix, limit = 1000 }) {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
      return { objects: keys.slice(0, limit).map(key => ({ key })), truncated: keys.length > limit };
    },
  };
  // Paid Sol avoids changing the free-model policy just to exercise streaming.
  sqlite.prepare('INSERT INTO billing_config (key,value,updated_at) VALUES (?,?,?)')
    .run('launch', JSON.stringify({ rates: { 'gpt-6.1-sol': { input: 1000, output: 2000 } }, refundPolicy: '', validityPolicy: '', registrationNumber: '', address: '', supportEmail: '' }), Date.now());
  sqlite.prepare('INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('fixture-credit', 'alice', 'live', 'topup', 1000000000, 'fixture-credit', Date.now());
  globalThis.fetch = async () => { providerCalls++; throw new Error('Unexpected provider call'); };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(console, originalConsole);
  sqlite.close();
});

function call(path, method = 'GET', body, headers = {}) {
  const form = body instanceof FormData;
  return route[method](new Request('https://prism.test/api/' + path, {
    method, headers: { origin: 'https://prism.test', 'sec-fetch-site': 'same-origin', ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
  }));
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const count = (table, owner = 'alice') => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get(owner).n;
function seed(owner) {
  const now = Date.now(), conversationId = owner + '-chat', fileId = owner + '-file', artifactId = owner + '-artifact', mediaId = owner + '-reference';
  const shareToken = (owner === 'alice' ? 'a' : 'b').repeat(64);
  sqlite.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(conversationId, owner, owner + ' private title', 'gpt-6.1-sol', now, now);
  sqlite.prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)').run(owner + '-message', conversationId, 'user', owner + ' private prompt', now);
  sqlite.prepare('INSERT INTO files (id,user_id,name,key,size,type,created_at) VALUES (?,?,?,?,?,?,?)').run(fileId, owner, 'notes.txt', owner + '/notes', 7, 'text/plain', now);
  sqlite.prepare('INSERT INTO work_artifacts (id,user_id,conversation_id,name,object_key,mime_type,size,created_at) VALUES (?,?,?,?,?,?,?,?)').run(artifactId, owner, conversationId, 'result.txt', owner + '/artifacts/result', 'application/octet-stream', 7, now);
  sqlite.prepare('INSERT INTO media_assets (id,user_id,kind,prompt,model,status,object_key,mime_type,size,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(mediaId, owner, 'reference', 'reference.png', '', 'complete', owner + '/references/image', 'image/png', 7, now, now);
  sqlite.prepare('INSERT INTO public_shares (id,user_id,conversation_id,token,title,snapshot,created_at) VALUES (?,?,?,?,?,?,?)').run(owner + '-share', owner, conversationId, shareToken, 'Shared title', '[{"role":"user","content":"Private shared prompt"}]', now);
  sqlite.prepare('INSERT INTO workspace_settings (user_id,settings,updated_at) VALUES (?,?,?)').run(owner, '{"memory":"Private saved preferences"}', now);
  sqlite.prepare('INSERT INTO browser_sessions (id,user_id,url,title,content,created_at) VALUES (?,?,?,?,?,?)').run(owner + '-browser', owner, 'https://example.org/', 'Saved page', 'Private saved page', now);
  for (const key of [owner + '/notes', owner + '/artifacts/result', owner + '/references/image', owner + '/untracked-upload']) objects.set(key, new TextEncoder().encode('private'));
  return { conversationId, fileId, artifactId, mediaId, shareToken };
}
const sse = () => new Response([
  { type: 'response.output_text.delta', delta: 'Completed provider answer.' },
  { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });

test('cancelled chat keeps its operation token until producer cleanup; pending deletion denies content and later resumes', { timeout: 10000 }, async () => {
  const alice = seed('alice'), bob = seed('bob'), started = deferred(), provider = deferred(), drained = deferred();
  let upstreamSignal, activeToken, cancellation;
  globalThis.fetch = async (_url, options) => { providerCalls++; upstreamSignal = options.signal; started.resolve(); return provider.promise; };
  onOperationRelease = token => { if (token === activeToken) drained.resolve(); };
  try {
    const response = await call('chat', 'POST', { conversationId: alice.conversationId, model: 'gpt-6.1-sol', prompt: 'Continue with a private answer.' });
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    await started.promise;
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"start"/);
    activeToken = sqlite.prepare("SELECT token FROM account_data_operations WHERE user_id='alice'").get().token;
    cancellation = reader.cancel('User stopped reading');
    await nextTask();
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(count('account_data_operations'), 1, 'consumer cancellation must not release a still-running producer');

    const deleting = await call('account/data', 'DELETE');
    assert.equal(deleting.status, 202);
    const pending = await deleting.json();
    assert.equal(pending.status, 'pending'); assert.equal(pending.phase, 'waiting'); assert.equal(pending.activeOperations, 1);
    assert.equal(objectDeletes.length, 0, 'storage cannot be swept while an old writer can still resume');
    assert.equal((await call('public-shares/' + alice.shareToken)).status, 404);
    assert.equal((await call('public-shares/' + bob.shareToken)).status, 200);

    for (const path of ['conversations', 'conversations/' + alice.conversationId, 'files', 'files/' + alice.fileId, 'media', 'media/' + alice.mediaId + '/content', 'artifacts/' + alice.artifactId, 'settings', 'search?q=private', 'shares', 'tasks', 'browser/sessions', 'usage', 'billing']) {
      const denied = await call(path);
      assert.equal(denied.status, 423, path + ': ' + await denied.clone().text());
      assert.equal((await denied.json()).code, 'ACCOUNT_DELETION_PENDING');
    }
    const form = new FormData(); form.append('file', new File(['new private text'], 'new.txt'));
    for (const [path, method, body] of [
      ['settings', 'PATCH', {}], ['shares', 'POST', { conversationId: alice.conversationId }],
      ['conversations/' + alice.conversationId, 'PATCH', { title: 'Changed title' }],
      ['files/' + alice.fileId, 'DELETE'], ['files', 'POST', form],
      ['chat', 'POST', { model: 'gpt-6.1-sol', prompt: 'A blocked new request' }],
    ]) {
      const denied = await call(path, method, body);
      assert.equal(denied.status, 423, path + ': ' + await denied.clone().text());
      assert.equal((await denied.json()).code, 'ACCOUNT_DELETION_PENDING');
    }
    assert.equal(providerCalls, 1); assert.equal(objectReads.length, 0);
    const repeated = await call('account/data', 'DELETE');
    assert.equal(repeated.status, 202); assert.equal((await repeated.json()).jobId, pending.jobId);
    assert.equal((await (await call('account/data')).json()).deletion.activeOperations, 1);

    // Only now allow the cancelled fetch to reject and its producer finally to run.
    provider.reject(new DOMException('provider cancelled', 'AbortError'));
    await drained.promise; await cancellation;
    assert.equal(count('account_data_operations'), 0);
    assert.equal((await (await call('account/data')).json()).deletion.activeOperations, 0);
    const completed = await call('account/data', 'DELETE');
    assert.equal(completed.status, 200, await completed.clone().text());
    const result = await completed.json();
    assert.equal(result.status, 'complete'); assert.equal(result.jobId, pending.jobId); assert.equal(result.deletedObjects, 4);
    for (const table of ['conversations', 'files', 'media_assets', 'work_artifacts', 'public_shares', 'workspace_settings', 'browser_sessions', 'chat_operations']) assert.equal(count(table), 0, table);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(alice.conversationId).n, 0);
    assert.equal([...objects.keys()].filter(key => key.startsWith('alice/')).length, 0);
    assert.equal(count('conversations', 'bob'), 1); assert.equal([...objects.keys()].filter(key => key.startsWith('bob/')).length, 4);
    const usage = sqlite.prepare("SELECT status,reserved_amount FROM usage WHERE user_id='alice'").get();
    assert.equal(usage.status, 'error'); assert.ok(usage.reserved_amount > 0, 'uncertain provider spend is retained for reconciliation');
    assert.ok(count('wallet_events') >= 2, 'workspace deletion cannot erase the initial credit or its reservation');
    assert.equal((await call('conversations/' + alice.conversationId)).status, 404);
    user = { userId: 'bob', email: 'bob@example.test' };
    assert.equal((await call('files/' + bob.fileId)).status, 200);
    assert.doesNotMatch(logs.join('\n'), /fixture-provider-secret|private R2 key|private answer/);
  } finally {
    provider.reject(new DOMException('test teardown', 'AbortError'));
    if (activeToken) await drained.promise;
    await cancellation;
  }
});

test('storage failures return retryable 202, revoke shares immediately, and preserve a manifest for an owner retry', async () => {
  const alice = seed('alice'); seed('bob'); storageFailure = true;
  const failed = await call('account/data', 'DELETE');
  assert.equal(failed.status, 202);
  const pending = await failed.json();
  assert.equal(pending.status, 'pending'); assert.equal(pending.lastErrorCode, 'DELETION_RETRY_REQUIRED');
  assert.equal(pending.retryable, true); assert.equal(pending.workerRunning, false); assert.equal(pending.activeOperations, 0);
  assert.ok(pending.pendingObjects > 0); assert.equal(count('conversations'), 1);
  assert.equal((await call('public-shares/' + alice.shareToken)).status, 404);
  assert.equal((await call('files/' + alice.fileId)).status, 423);
  assert.equal([...objects.keys()].filter(key => key.startsWith('alice/')).length, 4);
  assert.doesNotMatch(JSON.stringify(pending) + logs.join('\n'), /private R2 key|fixture-provider-secret/);
  storageFailure = false;
  const retried = await call('account/data', 'DELETE');
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal((await retried.json()).jobId, pending.jobId);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM account_deletion_jobs').get().n, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM account_deletion_objects').get().n, 0);
  assert.equal(count('conversations', 'bob'), 1);
});

test('a cancelled stream also retains its operation until an abort-insensitive provider resolves late', { timeout: 10000 }, async () => {
  const alice = seed('alice'), started = deferred(), provider = deferred(), drained = deferred();
  let token, cancellation;
  globalThis.fetch = async () => { providerCalls++; started.resolve(); return provider.promise; };
  onOperationRelease = released => { if (released === token) drained.resolve(); };
  try {
    const response = await call('chat', 'POST', { conversationId: alice.conversationId, model: 'gpt-6.1-sol', prompt: 'Complete this turn.' });
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    await started.promise;
    token = sqlite.prepare("SELECT token FROM account_data_operations WHERE user_id='alice'").get().token;
    cancellation = response.body.cancel(); await nextTask();
    assert.equal(count('account_data_operations'), 1);
    assert.equal((await call('account/data', 'DELETE')).status, 202);
    provider.resolve(sse());
    await drained.promise; await cancellation;
    assert.equal(count('account_data_operations'), 0);
    assert.equal(count('conversations'), 1, 'completion is still pending until its deletion job resumes');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND role='assistant'").get(alice.conversationId).n, 0, 'a late provider result cannot recreate or publish deleted content');
    const resumed = await call('account/data', 'DELETE');
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.equal(count('conversations'), 0); assert.equal(objects.size, 0);
  } finally {
    provider.resolve(sse());
    if (token) await drained.promise;
    await cancellation;
  }
});

test('account deletion requires a current authenticated owner and same-origin mutation', async () => {
  seed('alice'); seed('bob');
  user = null;
  assert.equal((await call('account/data', 'DELETE')).status, 401);
  user = { userId: 'alice', email: 'alice@example.test' };
  assert.equal((await call('account/data', 'DELETE', undefined, { origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('account/data', 'DELETE', undefined, { 'x-prism-rendered-account': 'bob' })).status, 409);
  assert.equal(count('conversations'), 1); assert.equal(count('conversations', 'bob'), 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM account_deletion_jobs').get().n, 0);
  user = { userId: 'bob', email: 'bob@example.test' };
  const deleted = await call('account/data', 'DELETE');
  assert.equal(deleted.status, 200);
  assert.equal(count('conversations', 'bob'), 0); assert.equal(count('conversations'), 1);
  assert.ok(objects.has('alice/notes'));
});

test('only the configured administrator can inspect or acknowledge alerts and resume another account deletion', async () => {
  const alice = seed('alice'); seed('bob'); storageFailure = true;
  assert.equal((await call('account/data', 'DELETE')).status, 202);
  storageFailure = false; env.ADMIN_USER_ID = 'operator';
  user = null;
  assert.equal((await call('admin/security')).status, 401);
  user = { userId: 'bob', email: 'bob@example.test' };
  for (let i = 0; i < 5; i++) assert.equal((await call('admin/security?private=do-not-log', 'GET', undefined, { authorization: 'Bearer do-not-log' })).status, 403);
  assert.equal((await call('admin/security', 'PATCH', { id: 'not-an-alert' })).status, 403);
  assert.equal((await call('admin/deletions/resume', 'POST', {})).status, 403);
  assert.equal(count('conversations'), 1);
  user = { userId: 'operator', email: 'operator@example.test' };
  const overview = await call('admin/security'); assert.equal(overview.status, 200);
  const report = await overview.json();
  const alert = report.alerts.find(entry => entry.category === 'access_denied');
  assert.ok(alert); assert.equal(alert.route, '/api/admin'); assert.equal(alert.state, 'open');
  assert.equal(report.delivery.externalNotifications, false);
  assert.doesNotMatch(JSON.stringify(report) + logs.join('\n'), /do-not-log|fixture-provider-secret|private R2 key/);
  assert.equal((await call('admin/security', 'PATCH', { id: alert.id })).status, 200);
  assert.equal(sqlite.prepare('SELECT state FROM security_alerts WHERE id=?').get(alert.id).state, 'acknowledged');
  assert.equal((await call('admin/security', 'PATCH', { id: '../bad-id' })).status, 404);
  const resumed = await call('admin/deletions/resume', 'POST', {});
  assert.equal(resumed.status, 200, await resumed.clone().text());
  assert.equal((await resumed.json()).deletions[0].status, 'complete');
  assert.equal(count('conversations'), 0); assert.equal(count('conversations', 'bob'), 1);
  assert.equal((await call('public-shares/' + alice.shareToken)).status, 404);
  assert.equal(count('account_data_operations', 'operator'), 0);
});
