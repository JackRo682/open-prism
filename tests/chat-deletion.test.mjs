import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise the real API handler against the real migrations, with only the
// Cloudflare/auth boundary and the model provider replaced by local fixtures.
const runtime = new URL('../.sites-runtime/chat-deletion-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
let user, sqlite, onRead, onObjectDelete;
const objects = new Map();
const env = { BETA_MODE: 'true', OPENAI_API_KEY: 'test-only-key' };
const originalFetch = globalThis.fetch;
globalThis.__chatDeletionTest = { env, getChatGPTUser: async () => user };
await writeFile(new URL('context.mjs', runtime), 'export const {env,getChatGPTUser}=globalThis.__chatDeletionTest;');
const modules = ['models', 'provider', 'chat-title', 'billing-contract', 'billing', 'beta', 'workspace-settings', 'workspace-tools', 'workspace-bootstrap', 'workspace-startup', 'conversation-actions', 'chat-generation', 'media-provider', 'media-workspace', 'browser-workspace', 'scheduled-tasks', 'schedule-time', 'work-artifacts', 'regenerate-style', 'guest-chat', 'guest-import', 'request-security', 'request-lease', 'schedule-runner', 'security-monitoring', 'account-deletion', 'upload-validation', 'image-validation', 'public-shares', 'upload-security', 'api-resource-guards'];
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
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const migration of migrations) sqlite.exec(migration);
  // Fund paid Sol so the existing ownership, deletion and security scenarios
  // reach their intended boundary after the free-model policy change.
  sqlite.prepare('INSERT INTO billing_config (key,value,updated_at) VALUES (?,?,?)')
    .run('launch', JSON.stringify({ rates: { 'gpt-6.1-sol': { input: 1000, output: 2000 } }, refundPolicy: '', validityPolicy: '', registrationNumber: '', address: '', supportEmail: '' }), Date.now());
  sqlite.prepare('INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('initial-credit', 'alice', 'live', 'topup', 1000000000, 'isolated-credit', Date.now());
  onRead = undefined; onObjectDelete = undefined; objects.clear();
  user = { userId: 'alice', email: 'alice@example.test' };
  env.DB = {
    prepare(query) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async first() {
          const result = sqlite.prepare(query).get(...values) ?? null;
          await onRead?.(query, values, result);
          return result;
        },
        async all() { return { results: sqlite.prepare(query).all(...values) }; },
        async run() { return { success: true, meta: { changes: Number(sqlite.prepare(query).run(...values).changes) } }; },
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
    async delete(key) { await onObjectDelete?.(key); objects.delete(key); },
    async get(key) { return objects.has(key) ? { body: new Blob([objects.get(key)]).stream() } : null; },
  };
  globalThis.fetch = async () => { throw new Error('Unexpected provider request'); };
});
afterEach(() => { globalThis.fetch = originalFetch; sqlite.close(); });

function call(path, method = 'GET', body, headers = {}) {
  return route[method](new Request('https://prism.test/api/' + path, {
    method, headers: { origin: 'https://prism.test', ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
}
function seed(id = 'chat-alice', owner = 'alice') {
  const now = Date.now();
  sqlite.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, owner, 'Saved conversation', 'gpt-6.1-sol', now, now);
  sqlite.prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)').run(id + '-message', id, 'user', 'A saved prompt', now);
  return id;
}
function seedArtifact(id, owner = 'alice') {
  const key = owner + '/artifacts/' + id, artifactId = id + '-file';
  objects.set(key, 'original file bytes');
  sqlite.prepare('INSERT INTO work_artifacts (id,user_id,conversation_id,name,object_key,mime_type,size,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(artifactId, owner, id, 'result.csv', key, 'text/csv', 19, Date.now());
  return { key, artifactId };
}
const exists = id => !!sqlite.prepare('SELECT id FROM conversations WHERE id=?').get(id);
const lock = (id, expires = Date.now() + 60_000) => sqlite.prepare('INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?)').run('chat:' + id, expires);
const sse = () => new Response([
  { type: 'response.output_text.delta', delta: 'Saved answer.' },
  { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('anonymous, foreign-owner and cross-origin delete requests cannot touch saved data', async () => {
  const id = seed(); const { key } = seedArtifact(id);
  user = null;
  assert.equal((await call('conversations/' + id, 'DELETE')).status, 401);
  user = { userId: 'bob', email: 'bob@example.test' };
  assert.equal((await call('conversations/' + id, 'DELETE')).status, 404);
  user = { userId: 'alice', email: 'alice@example.test' };
  assert.equal((await call('conversations/' + id, 'DELETE', undefined, { origin: 'https://other.test' })).status, 403);
  assert.equal(exists(id), true); assert.equal(objects.has(key), true);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id=?').get(id).n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM rate_limits WHERE key LIKE 'chat:%'").get().n, 0);
});

test('deletion removes messages, shared snapshots and generated files while retaining unrelated chats and usage', async () => {
  const id = seed(), other = seed('chat-bob', 'bob'), { key, artifactId } = seedArtifact(id);
  const token = 'a'.repeat(64), now = Date.now();
  sqlite.prepare('INSERT INTO public_shares (id,user_id,conversation_id,token,title,snapshot,created_at) VALUES (?,?,?,?,?,?,?)').run('share-alice', 'alice', id, token, 'Snapshot', '[]', now);
  sqlite.prepare('INSERT INTO scheduled_tasks (id,user_id,title,prompt,model,timezone,recurrence,scheduled_at,last_conversation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('task-alice', 'alice', 'Task', 'Summarize', 'gpt-6.1-sol', 'UTC', 'once', now + 60_000, id, now, now);
  sqlite.prepare('INSERT INTO usage (id,user_id,model,provider,status,reserved_amount,created_at) VALUES (?,?,?,?,?,?,?)').run('usage-alice', 'alice', 'gpt-6.1-sol', 'openai', 'complete', 1234, now);
  const result = await call('conversations/' + id, 'DELETE');
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { ok: true });
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(exists(id), false); assert.equal(exists(other), true);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id=?').get(id).n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM public_shares WHERE conversation_id=?').get(id).n, 0);
  assert.equal(sqlite.prepare('SELECT last_conversation_id FROM scheduled_tasks WHERE id=?').get('task-alice').last_conversation_id, null);
  assert.equal(sqlite.prepare('SELECT reserved_amount FROM usage WHERE id=?').get('usage-alice').reserved_amount, 1234);
  assert.equal(objects.has(key), false);
  assert.equal((await call('artifacts/' + artifactId)).status, 404);
  assert.equal((await call('public-shares/' + token)).status, 404);
  assert.equal((await call('conversations/' + id)).status, 404);
  assert.equal((await call('conversations/' + id, 'DELETE')).status, 404);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM rate_limits WHERE key LIKE 'chat:%'").get().n, 0);
});

test('an active response lock blocks only that conversation and expired locks do not prevent deletion', async () => {
  const busy = seed(), idle = seed('chat-idle'), expired = seed('chat-expired');
  lock(busy); lock(expired, Date.now() - 1);
  const blocked = await call('conversations/' + busy, 'DELETE');
  assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, 'CONVERSATION_BUSY');
  assert.equal(exists(busy), true);
  assert.equal((await call('conversations/' + idle, 'DELETE')).status, 200);
  assert.equal((await call('conversations/' + expired, 'DELETE')).status, 200);
  assert.ok(sqlite.prepare('SELECT key FROM rate_limits WHERE key=?').get('chat:' + busy));
});

test('a real pending chat stream prevents deletion and deletion succeeds after the response finishes', { timeout: 10_000 }, async () => {
  const id = seed(), started = deferred(), provider = deferred();
  globalThis.fetch = async () => { started.resolve(); return provider.promise; };
  const response = await call('chat', 'POST', { conversationId: id, model: 'gpt-6.1-sol', prompt: 'Continue the conversation.' });
  try {
    assert.equal(response.status, 200); await started.promise;
    assert.equal((await call('conversations/' + id, 'DELETE')).status, 409);
    assert.equal(exists(id), true);
  } finally { provider.resolve(sse()); }
  const events = await response.text(); assert.match(events, /"type":"done"/);
  assert.equal((await call('conversations/' + id, 'DELETE')).status, 200);
  assert.equal(exists(id), false);
  assert.equal(sqlite.prepare('SELECT status FROM usage WHERE user_id=?').get('alice').status, 'complete');
});

test('new generation is rejected while deletion is cleaning stored files', { timeout: 10_000 }, async () => {
  const id = seed(), deleting = deferred(), cleanup = deferred(); seedArtifact(id);
  onObjectDelete = async () => { deleting.resolve(); await cleanup.promise; };
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; return sse(); };
  const result = call('conversations/' + id, 'DELETE');
  try {
    await deleting.promise;
    assert.equal((await call('chat', 'POST', { conversationId: id, model: 'gpt-6.1-sol', prompt: 'Concurrent request' })).status, 409);
    assert.equal(providerCalls, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
  } finally { cleanup.resolve(); }
  assert.equal((await result).status, 200); assert.equal(exists(id), false);
});

test('storage failure reports failure, preserves the chat and releases the deletion lock for retry', async () => {
  const id = seed(), { key } = seedArtifact(id);
  onObjectDelete = async () => { throw new Error('Storage unavailable'); };
  assert.equal((await call('conversations/' + id, 'DELETE')).status, 500);
  assert.equal(exists(id), true); assert.equal(objects.has(key), true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM rate_limits WHERE key LIKE 'chat:%'").get().n, 0);
  onObjectDelete = undefined;
  assert.equal((await call('conversations/' + id, 'DELETE')).status, 200);
});

test('a conversation removed between ownership lookup and acquiring the generation lock is not sent to a provider', async () => {
  const id = seed(); let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; return sse(); };
  onRead = async (query, values, result) => {
    if (query === 'SELECT id FROM conversations WHERE id=? AND user_id=?' && values[0] === id && result) {
      onRead = undefined;
      // Deterministically interleave another request's completed deletion after
      // this request has read ownership but before it acquires its response lock.
      sqlite.prepare('DELETE FROM conversations WHERE id=?').run(id);
    }
  };
  const result = await call('chat', 'POST', { conversationId: id, model: 'gpt-6.1-sol', prompt: 'Stale conversation' });
  assert.equal(result.status, 404); assert.equal(providerCalls, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
  assert.equal(sqlite.prepare('SELECT key FROM rate_limits WHERE key=?').get('chat:' + id), undefined);
});
