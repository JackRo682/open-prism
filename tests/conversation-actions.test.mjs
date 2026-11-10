import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise the real API handler against the real migrations, with only the
// Cloudflare/auth boundary and the model provider replaced by local fixtures.
const runtime = new URL('../.sites-runtime/conversation-actions-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
let user, sqlite, onRead, onObjectDelete, beforeRun;
const objects = new Map();
const env = { BETA_MODE: 'true', OPENAI_API_KEY: 'test-only-key' };
const originalFetch = globalThis.fetch;
function fixtureBalance(owner='alice',amount=0){
 const current=sqlite.prepare("SELECT COALESCE(SUM(amount),0) n FROM wallet_events WHERE user_id=? AND mode='live'").get(owner).n;
 const delta=amount-current;if(!delta)return;
 const id=crypto.randomUUID();sqlite.prepare('INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at) VALUES (?,?,?,?,?,?,?)').run(id,owner,'live',delta<0?'reserve':'topup',delta,'fixture-balance:'+id,Date.now());
}

globalThis.__conversationActionsTest = { env, getChatGPTUser: async () => user };
await writeFile(new URL('context.mjs', runtime), 'export const {env,getChatGPTUser}=globalThis.__conversationActionsTest;');
const modules = ['models', 'provider', 'chat-title', 'billing-contract', 'billing', 'beta', 'workspace-settings', 'workspace-tools', 'workspace-bootstrap', 'workspace-startup', 'conversation-actions', 'chat-generation', 'media-provider', 'media-workspace', 'browser-workspace', 'scheduled-tasks', 'schedule-time', 'work-artifacts', 'regenerate-style', 'guest-chat', 'guest-import', 'request-security', 'request-lease', 'schedule-runner', 'security-monitoring', 'account-deletion', 'upload-validation', 'image-validation', 'public-shares', 'upload-security', 'api-resource-guards'];
for (const [source, target] of [...modules.map(name => ['lib/' + name + '.ts', name + '.mjs']), ['app/api/[...path]/route.ts', 'route.mjs']]) {
  let code = (await readFile(new URL('../' + source, import.meta.url), 'utf8'))
    .replaceAll("'cloudflare:workers'", "'./context.mjs'")
    .replaceAll("'../../chatgpt-auth'", "'./context.mjs'");
  for (const name of modules) code = code.replaceAll("'../../../lib/" + name + "'", "'./" + name + ".mjs'").replaceAll("'./" + name + "'", "'./" + name + ".mjs'");
  await writeFile(new URL(target, runtime), ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const route = await import(new URL('route.mjs', runtime));
const { withUntrustedDocuments, PROVIDER_INPUT_OVERHEAD_BYTES } = await import(new URL('provider.mjs', runtime));
const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url)))
  .filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')));

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const migration of migrations) sqlite.exec(migration);
  // Existing conversation/revision scenarios now exercise paid Sol even when
  // the site's checkout is still in beta. Funds are isolated test fixtures.
  sqlite.prepare('INSERT INTO billing_config (key,value,updated_at) VALUES (?,?,?)')
    .run('launch', JSON.stringify({ rates: Object.fromEntries(['gpt-6.1-sol', 'gpt-6-astra', 'claude-fable-5-1', 'gemini-4-argon'].map(id => [id, { input: 1000, output: 2000 }])), refundPolicy: '', validityPolicy: '', registrationNumber: '', address: '', supportEmail: '' }), Date.now());
  sqlite.prepare('INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('initial-credit', 'alice', 'live', 'topup', 100000000, 'isolated-credit', Date.now());
  onRead = undefined; onObjectDelete = undefined; beforeRun = undefined; objects.clear();
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, { BETA_MODE: 'true', OPENAI_API_KEY: 'test-only-key' });
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
        _run() { beforeRun?.(query, values); return { success: true, meta: { changes: Number(sqlite.prepare(query).run(...values).changes) } }; },
        async run() { return this._run(); },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement._run());
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

function call(path, method = 'GET', body, headers = {}, signal) {
  return route[method](new Request('https://prism.test/api/' + path, {
    method, signal, headers: { origin: 'https://prism.test', ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
}

function seed(id = 'chat-alice', { owner = 'alice', turns = ['First question', 'First answer', 'Second question', 'Second answer'], updated = 10 } = {}) {
  sqlite.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, owner, 'Original title', 'gpt-6.1-sol', 1, updated);
  for (const [index, content] of turns.entries()) sqlite.prepare('INSERT INTO messages (id,conversation_id,role,content,model,created_at) VALUES (?,?,?,?,?,?)')
    .run(id + '-m' + index, id, index % 2 ? 'assistant' : 'user', content, index % 2 ? 'gpt-6.1-sol' : null, index + 1);
  return id;
}
const messages = id => sqlite.prepare('SELECT id,role,content,model,created_at,usage_id FROM messages WHERE conversation_id=? ORDER BY created_at,rowid').all(id).map(row => ({ ...row }));
const count = table => sqlite.prepare('SELECT COUNT(*) n FROM ' + table).get().n;
const securityCount = category => sqlite.prepare('SELECT COALESCE(SUM(event_count),0) n FROM security_event_windows WHERE category=?').get(category).n;
const request = (conversationId, action, messageId, extra = {}) => ({ conversationId, action, messageId, model: 'gpt-6.1-sol', prompt: 'Edited question', clientRequestId: crypto.randomUUID(), ...extra });
const jsonOf = async response => { assert.ok(response.ok, await response.clone().text()); return response.json(); };
const eventsOf = async response => {
  const text = await response.text(); assert.ok(response.ok, text);
  return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
};
const doneOf = events => { const done = events.find(event => event.type === 'done'); assert.ok(done, JSON.stringify(events)); return done; };
const sse = (text = 'Fresh provider answer') => new Response([
  { type: 'response.output_text.delta', delta: text },
  { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('pinning persists, sorts before recent chats, preserves activity time, and supports unpinning', async () => {
  const older = seed('older', { updated: 10 }), newer = seed('newer', { updated: 100 });
  const pinned = await jsonOf(await call('conversations/' + older, 'PATCH', { pinned: true }));
  assert.equal(pinned.ok, true); assert.ok(pinned.conversation.pinned_at > 0); assert.equal(pinned.conversation.updated_at, 10);
  const repeated = await jsonOf(await call('conversations/' + older, 'PATCH', { pinned: true }));
  assert.equal(repeated.conversation.pinned_at, pinned.conversation.pinned_at);
  assert.deepEqual((await jsonOf(await call('conversations'))).map(chat => chat.id), [older, newer]);
  assert.equal((await call('conversations/' + older, 'PATCH', { pinned: 'yes' })).status, 400);
  const unpinned = await jsonOf(await call('conversations/' + older, 'PATCH', { pinned: false }));
  assert.equal(unpinned.conversation.pinned_at, null); assert.equal(unpinned.conversation.updated_at, 10);
  assert.deepEqual((await jsonOf(await call('conversations'))).map(chat => chat.id), [newer, older]);
  user = { userId: 'bob', email: 'bob@example.test' };
  assert.equal((await call('conversations/' + older, 'PATCH', { pinned: true })).status, 404);
});

test('feedback is durable, reversible, response-only, and scoped to the message owner', async () => {
  const id = seed(), endpoint = `conversations/${id}/messages/${id}-m3/feedback`;
  assert.equal((await jsonOf(await call(endpoint, 'POST', { rating: 'up' }))).rating, 'up');
  assert.equal((await jsonOf(await call('conversations/' + id))).messages.at(-1).feedback, 'up');
  const negative = await jsonOf(await call(endpoint, 'POST', { rating: 'down', details: 'The steps need a clearer explanation.' }));
  assert.equal(negative.rating, 'down'); assert.equal(count('message_feedback'), 1);
  const detail = await jsonOf(await call(`conversations/${id}/messages/${id}-m3/details`));
  assert.equal(detail.model, 'gpt-6.1-sol'); assert.equal(detail.provider, 'openai'); assert.equal(detail.createdAt, 4);
  assert.equal(detail.usage, null, 'legacy replies without an explicit usage link must not receive invented token counts');
  assert.equal(detail.feedback.details, negative.details);
  assert.equal((await call(endpoint, 'POST', { rating: 1 })).status, 400);
  assert.equal((await call(`conversations/${id}/messages/${id}-m2/feedback`, 'POST', { rating: 'up' })).status, 400);
  assert.equal((await call(endpoint, 'POST', { rating: 'up' }, { origin: 'https://other.test' })).status, 403);
  user = { userId: 'bob', email: 'bob@example.test' };
  assert.equal((await call(endpoint, 'POST', { rating: 'up' })).status, 404);
  assert.equal((await call(`conversations/${id}/messages/${id}-m3/details`)).status, 404);
  user = { userId: 'alice', email: 'alice@example.test' };
  assert.equal((await jsonOf(await call(endpoint, 'POST', { rating: null }))).rating, null);
  assert.equal(count('message_feedback'), 0);
});

test('reports create a durable receipt exactly once, retain evidence after chat deletion, and restrict review to the admin', async () => {
  const id = seed(), endpoint = `conversations/${id}/reports`;
  const body = { messageId: id + '-m3', category: 'copyright', details: 'This answer appears to reproduce my original work without permission.', requestId: crypto.randomUUID() };
  const first = await call(endpoint, 'POST', body); assert.equal(first.status, 201);
  const receipt = await first.json(); assert.equal(receipt.status, 'submitted'); assert.ok(receipt.id); assert.ok(receipt.createdAt);
  const repeated = await jsonOf(await call(endpoint, 'POST', body)); assert.equal(repeated.id, receipt.id); assert.equal(repeated.reused, true); assert.equal(count('conversation_reports'), 1);
  sqlite.prepare('DELETE FROM messages WHERE id=?').run(body.messageId);
  const afterReplacement = await jsonOf(await call(endpoint, 'POST', body));
  assert.equal(afterReplacement.id, receipt.id); assert.equal(afterReplacement.reused, true);
  assert.equal(count('conversation_reports'), 1, 'replacing the reported response must not invalidate its receipt or duplicate the report');
  assert.equal((await call(endpoint, 'POST', { ...body, details: 'A different complaint using the same identifier.' })).status, 409);
  assert.equal((await call(endpoint, 'POST', { ...body, requestId: crypto.randomUUID(), details: 'short' })).status, 400);
  assert.equal((await call('admin/reports')).status, 403);
  user = { userId: 'bob', email: 'bob@example.test' };
  assert.equal((await call('reports/' + receipt.id)).status, 404);
  user = { userId: 'alice', email: 'alice@example.test' }; env.ADMIN_USER_ID = 'alice';
  const review = await jsonOf(await call('admin/reports')); assert.equal(review.reports.length, 1);
  assert.equal(JSON.parse(review.reports[0].snapshot).content, 'Second answer');
  assert.equal((await jsonOf(await call('admin/reports/' + receipt.id, 'PATCH', { status: 'reviewing', resolution: 'Assigned for review.' }))).status, 'reviewing');
  assert.equal((await call('conversations/' + id, 'DELETE')).status, 200);
  const preserved = sqlite.prepare('SELECT * FROM conversation_reports WHERE id=?').get(receipt.id);
  assert.equal(preserved.conversation_id, null); assert.equal(preserved.message_id, null);
  assert.equal(JSON.parse(preserved.snapshot).content, 'Second answer');
  assert.equal((await jsonOf(await call('reports/' + receipt.id))).status, 'reviewing');
});

test('Google export configuration does not claim a connection when no OAuth client is configured', async () => {
  assert.deepEqual(await jsonOf(await call('integrations/google-export')), { configured: false });
  env.GOOGLE_DRIVE_CLIENT_ID = 'public-test-client.apps.googleusercontent.com';
  assert.deepEqual(await jsonOf(await call('integrations/google-export')), { configured: true, clientId: env.GOOGLE_DRIVE_CLIENT_ID });
  user = null;
  assert.equal((await call('integrations/google-export')).status, 401);
});

test('new replies expose canonical message IDs and measured details; successful request replay never charges or calls the provider again', async () => {
  let providerCalls = 0; globalThis.fetch = async () => {
    providerCalls++;
    const reserved=sqlite.prepare('SELECT status,reserved_amount FROM usage').get();
    assert.equal(reserved.status,'pending'); assert.ok(reserved.reserved_amount>0);
    return sse();
  };
  const body = { model: 'gpt-6.1-sol', prompt: 'A new question', clientRequestId: crypto.randomUUID() };
  const first = await call('chat', 'POST', body); assert.equal(first.status, 200);
  const events = await eventsOf(first), done = doneOf(events), start = events[0];
  const saved = messages(done.conversationId);
  assert.equal(saved[0].id, start.userMessageId); assert.equal(saved[1].id, start.assistantMessageId);
  assert.equal(saved[1].id, done.assistantMessageId); assert.equal(saved[1].usage_id, done.requestId);
  const detail = await jsonOf(await call(`conversations/${done.conversationId}/messages/${done.assistantMessageId}/details`));
  assert.equal(detail.createdAt, saved[1].created_at); assert.equal(detail.usage.inputTokens, 10); assert.equal(detail.usage.outputTokens, 5); assert.equal(detail.usage.status, 'complete');
  const allowance = sqlite.prepare('SELECT reserved_amount FROM usage').get().reserved_amount;
  const replay = doneOf(await eventsOf(await call('chat', 'POST', body)));
  assert.equal(replay.replayed, true); assert.equal(replay.assistantMessageId, done.assistantMessageId);
  assert.equal(providerCalls, 1); assert.equal(count('usage'), 1); assert.equal(count('messages'), 2);
  assert.equal(sqlite.prepare('SELECT reserved_amount FROM usage').get().reserved_amount, allowance);
  assert.equal((await call('chat', 'POST', { ...body, prompt: 'Different question' })).status, 409);
  assert.equal((await call('conversations/' + done.conversationId, 'DELETE')).status, 200);
  const deletedReplay = await call('chat', 'POST', body); assert.equal(deletedReplay.status, 409); assert.equal((await deletedReplay.json()).code, 'REQUEST_SUPERSEDED');
  assert.equal(providerCalls, 1);
  assert.equal(securityCount('resource_spike'),1,'successful replay and rejected duplicate never dispatch again');
});

test('SSE monitoring measures completed generation rather than HTTP setup at the 120-second boundary', async () => {
  const realNow=Date.now;
  let now=Date.parse('2026-11-10T00:00:00Z');
  Date.now=()=>now;
  try {
    for(const duration of [119999,120000]) {
      const begun=deferred(), provider=deferred();
      globalThis.fetch=async()=>{begun.resolve(); return provider.promise;};
      const response=await call('chat','POST',{model:'gpt-6.1-sol',prompt:'Private timing fixture',clientRequestId:crypto.randomUUID()});
      await begun.promise;
      assert.equal(response.status,200); assert.equal(securityCount('slow_request'),0);
      now+=duration;
      provider.resolve(sse());
      doneOf(await eventsOf(response));
      assert.equal(securityCount('slow_request'),Number(duration>=120000));
    }
    assert.equal(securityCount('resource_spike'),2);
    assert.equal(securityCount('server_error'),0);
    assert.doesNotMatch(JSON.stringify(sqlite.prepare('SELECT * FROM security_event_windows').all()),/Private timing|alice|example\.test/);
  } finally { Date.now=realNow; }
});

test('duplicate in-flight requests and concurrent revisions cannot double-reserve or remove another request lock', async () => {
  const id = seed(), begun = deferred(), provider = deferred(); let calls = 0;
  globalThis.fetch = async () => { calls++; begun.resolve(); return provider.promise; };
  const body = request(id, 'regenerate', id + '-m3');
  const first = await call('chat', 'POST', body); await begun.promise;
  try {
    const duplicate = await call('chat', 'POST', body); assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, 'REQUEST_IN_PROGRESS');
    const other = await call('chat', 'POST', { ...body, clientRequestId: crypto.randomUUID() }); assert.equal(other.status, 409); assert.equal((await other.json()).code, 'CONVERSATION_BUSY');
    assert.equal(calls, 1); assert.equal(count('usage'), 1);
    assert.ok(sqlite.prepare('SELECT key FROM rate_limits WHERE key=?').get('chat:' + id));
  } finally { provider.resolve(sse()); }
  doneOf(await eventsOf(first));
  assert.equal(sqlite.prepare('SELECT key FROM rate_limits WHERE key=?').get('chat:' + id), undefined);
});

test('operation status resolves pending, committed, and failed requests for their owner without starting inference', async () => {
  const id = seed(), begun = deferred(), provider = deferred(); let calls = 0;
  globalThis.fetch = async () => { calls++; begun.resolve(); return provider.promise; };
  const first = await call('chat', 'POST', request(id, 'regenerate', id + '-m3')); await begun.promise;
  const requestId = sqlite.prepare('SELECT id FROM chat_operations').get().id;
  const endpoint = 'chat/operations/' + requestId;
  try {
    const pending = await call(endpoint); assert.equal(pending.headers.get('Cache-Control'), 'no-store');
    const status = await jsonOf(pending);
    assert.equal(status.status, 'running'); assert.equal(status.conversationId, id); assert.equal(status.userMessageId, id + '-m2');
    assert.equal(status.requestId, requestId); assert.equal(status.error, null);
    assert.equal(Object.hasOwn(status, 'request_hash'), false); assert.equal(Object.hasOwn(status, 'user_id'), false);
    user = { userId: 'bob', email: 'bob@example.test' };
    assert.equal((await call(endpoint)).status, 404);
    user = null; assert.equal((await call(endpoint)).status, 401);
    user = { userId: 'alice', email: 'alice@example.test' };
    assert.equal((await call('chat/operations/' + crypto.randomUUID())).status, 404);
    assert.equal(calls, 1); assert.equal(count('usage'), 1);
  } finally { user = { userId: 'alice', email: 'alice@example.test' }; provider.resolve(sse()); }
  const done = doneOf(await eventsOf(first)), completed = await jsonOf(await call(endpoint));
  assert.equal(completed.status, 'complete'); assert.equal(completed.assistantMessageId, done.assistantMessageId);
  assert.equal(calls, 1); assert.equal(count('usage'), 1);
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 500 }); };
  const failed = await eventsOf(await call('chat', 'POST', request(id, 'edit', id + '-m0')));
  const failedStatus = await jsonOf(await call('chat/operations/' + failed[0].requestId));
  assert.equal(failedStatus.status, 'error'); assert.ok(failedStatus.error); assert.equal(calls, 2);
});

test('client request status resolves before the first stream event and isolates owner-scoped request keys', async () => {
  const claimed = deferred(), release = deferred(); let providerCalls = 0;
  const clientRequestId = crypto.randomUUID(), endpoint = 'chat/operations/' + clientRequestId + '?by=client';
  assert.equal((await call(endpoint)).status, 404, 'a not-yet-recorded client request must stay unknown');
  assert.equal(count('chat_operations'), 0); assert.equal(count('usage'), 0);
  onRead = async (query, values, result) => {
    if (query.startsWith('INSERT INTO chat_operations') && result) { claimed.resolve(); await release.promise; }
  };
  globalThis.fetch = async () => { providerCalls++; return sse(); };
  const responsePromise = call('chat', 'POST', { model: 'gpt-6.1-sol', prompt: 'Recover this request without seeing its start event.', clientRequestId });
  await claimed.promise;
  let operation;
  try {
    const response = await call(endpoint); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    operation = await jsonOf(response);
    assert.equal(operation.status, 'preparing'); assert.ok(operation.requestId); assert.ok(operation.conversationId);
    assert.notEqual(operation.requestId, clientRequestId);
    user = { userId: 'bob', email: 'bob@example.test' };
    assert.equal((await call(endpoint)).status, 404);
    assert.equal((await call('chat/operations/' + operation.requestId)).status, 404);
    user = null; assert.equal((await call(endpoint)).status, 401);
    user = { userId: 'alice', email: 'alice@example.test' };
    assert.equal((await call('chat/operations/' + 'x'.repeat(101) + '?by=client')).status, 404);
    assert.equal((await call('chat/operations/' + clientRequestId + '?by=unknown')).status, 400);
    assert.equal(providerCalls, 0); assert.equal(count('usage'), 0); assert.equal(count('chat_operations'), 1);
  } finally { user = { userId: 'alice', email: 'alice@example.test' }; onRead = undefined; release.resolve(); }
  const done = doneOf(await eventsOf(await responsePromise));
  const completed = await jsonOf(await call(endpoint));
  assert.equal(completed.status, 'complete'); assert.equal(completed.requestId, done.requestId);
  assert.equal(completed.assistantMessageId, done.assistantMessageId);
  assert.deepEqual(completed, await jsonOf(await call('chat/operations/' + operation.requestId)));
  assert.equal(providerCalls, 1); assert.equal(count('usage'), 1); assert.equal(count('chat_operations'), 1);
});

test('regeneration reuses the saved latest prompt exactly, archives the former answer, and leaves earlier turns intact', async () => {
  const id = seed(), original = messages(id); let sent;
  globalThis.fetch = async (url, options) => { sent = JSON.parse(options.body).input; return sse('Regenerated answer'); };
  const body = request(id, 'regenerate', id + '-m3', { prompt: 'Do not send this substitute.' });
  const done = doneOf(await eventsOf(await call('chat', 'POST', body)));
  assert.deepEqual(sent.map(turn => turn.content), ['First question', 'First answer', 'Second question']);
  const saved = messages(id); assert.equal(saved.length, 4); assert.deepEqual(saved.slice(0, 3), original.slice(0, 3));
  assert.equal(saved[3].content, 'Regenerated answer'); assert.notEqual(saved[3].id, original[3].id);
  const archive = await jsonOf(await call(`conversations/${id}/revisions/${done.revisionId}`));
  assert.deepEqual(archive.messages.map(message => message.content), ['Second answer']);
  assert.equal(archive.messages[0].id, original[3].id); assert.equal(archive.revision.action, 'regenerate');
  user = { userId: 'bob', email: 'bob@example.test' };
  assert.equal((await call(`conversations/${id}/revisions/${done.revisionId}`)).status, 404);
});

test('regeneration styles reach the provider without changing the saved prompt and are part of idempotency', async () => {
  const sent = []; globalThis.fetch = async (url, options) => { sent.push(JSON.parse(options.body).input); return sse(); };
  for (const style of ['longer', 'shorter']) {
    const id = seed('style-' + style), original = messages(id);
    const body = request(id, 'regenerate', id + '-m3', { regenerateStyle: style, prompt: 'Untrusted replacement prompt' });
    const done = doneOf(await eventsOf(await call('chat', 'POST', body)));
    const input = sent.at(-1);
    assert.deepEqual(input.slice(0, -1).map(turn => turn.content), original.slice(0, 2).map(turn => turn.content));
    assert.ok(input.at(-1).content.startsWith('Second question\n\n'));
    assert.match(input.at(-1).content, new RegExp(style === 'longer' ? 'longer, more detailed' : 'shorter, more concise'));
    assert.doesNotMatch(input.at(-1).content, /Untrusted replacement prompt/);
    assert.deepEqual(messages(id).slice(0, 3), original.slice(0, 3));
    const calls = sent.length;
    assert.equal(doneOf(await eventsOf(await call('chat', 'POST', body))).assistantMessageId, done.assistantMessageId);
    const conflict = await call('chat', 'POST', { ...body, regenerateStyle: style === 'longer' ? 'shorter' : 'longer' });
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(sent.length, calls);
  }
  const id = seed('style-default'), body = request(id, 'regenerate', id + '-m3');
  const done = doneOf(await eventsOf(await call('chat', 'POST', body)));
  assert.equal(sent.at(-1).at(-1).content, 'Second question');
  assert.equal(doneOf(await eventsOf(await call('chat', 'POST', { ...body, regenerateStyle: 'retry' }))).assistantMessageId, done.assistantMessageId);
  assert.equal(sent.length, 3);
});

test('without-personalization regeneration omits saved context and skills only for that request', async () => {
  const id = seed(), sent = [];
  env.WORK_CODE_EXECUTION_ENABLED = 'false';
  const settings = { personalizationEnabled: true, customInstructions: 'PERSONAL_INSTRUCTIONS_MARKER', memory: 'SAVED_MEMORY_MARKER', workResponseStyle: 'direct', skills: [{ id: 'private-skill', name: 'Private skill', instructions: 'SAVED_SKILL_MARKER' }] };
  await jsonOf(await call('settings', 'PATCH', settings));
  const persistedSettings = sqlite.prepare('SELECT settings FROM workspace_settings WHERE user_id=?').get('alice').settings;
  globalThis.fetch = async (url, options) => { sent.push(JSON.parse(options.body).input); return sse(); };
  const normal = doneOf(await eventsOf(await call('chat', 'POST', request(id, 'regenerate', id + '-m3', { workspaceMode: 'work', skillId: 'private-skill', regenerateStyle: 'retry' }))));
  for (const marker of ['PERSONAL_INSTRUCTIONS_MARKER', 'SAVED_MEMORY_MARKER', 'SAVED_SKILL_MARKER']) assert.ok(sent[0].at(-1).content.includes(marker));
  assert.match(sent[0].at(-1).content, /responseStyle/);
  doneOf(await eventsOf(await call('chat', 'POST', request(id, 'regenerate', normal.assistantMessageId, { workspaceMode: 'work', skillId: 'missing-skill', regenerateStyle: 'no_personalization' }))));
  assert.equal(sent[1].at(-1).content, 'Second question');
  assert.equal(sqlite.prepare('SELECT settings FROM workspace_settings WHERE user_id=?').get('alice').settings, persistedSettings);
  assert.equal(messages(id)[2].content, 'Second question');
  assert.equal(count('usage'), 2);
});

test('unknown regeneration styles and styles on append or edit are rejected before reservation or provider access', async () => {
  const id = seed(), original = messages(id); let calls = 0;
  globalThis.fetch = async () => { calls++; return sse(); };
  for (const regenerateStyle of ['unknown', '', null, 42, {}, ['longer']]) {
    assert.equal((await call('chat', 'POST', request(id, 'regenerate', id + '-m3', { regenerateStyle }))).status, 400);
  }
  for (const action of ['append', 'edit']) assert.equal((await call('chat', 'POST', request(id, action, id + '-m2', { regenerateStyle: 'retry' }))).status, 400);
  assert.equal(calls, 0); assert.equal(count('usage'), 0); assert.equal(count('chat_operations'), 0);
  assert.deepEqual(messages(id), original);
});

test('retrying an unanswered saved user turn never duplicates the prompt and stale regeneration does not reach the provider', async () => {
  const id = seed('unanswered', { turns: ['First question', 'First answer', 'Latest unanswered question'] }); let calls = 0;
  globalThis.fetch = async () => { calls++; return sse(); };
  const stale = await call('chat', 'POST', request(id, 'regenerate', id + '-m1'));
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'STALE_MESSAGE'); assert.equal(calls, 0); assert.equal(count('usage'), 0);
  doneOf(await eventsOf(await call('chat', 'POST', request(id, 'regenerate', id + '-m2'))));
  assert.equal(messages(id).length, 4); assert.equal(messages(id).filter(message => message.content === 'Latest unanswered question').length, 1);
  assert.equal(count('conversation_revisions'), 0); assert.equal(calls, 1);
});

test('editing an earlier prompt commits a new suffix only after success and archives every replaced message', async () => {
  const id = seed('editable', { turns: ['First question', 'First answer', 'Old second question', 'Old second answer', 'Later question', 'Later answer'] });
  const original = messages(id), begun = deferred(), provider = deferred(); let sent;
  globalThis.fetch = async (url, options) => { sent = JSON.parse(options.body).input; begun.resolve(); return provider.promise; };
  await call('conversations/' + id, 'PATCH', { pinned: true });
  const first = await call('chat', 'POST', request(id, 'edit', id + '-m2', { prompt: 'Revised second question' })); await begun.promise;
  assert.deepEqual(messages(id), original, 'the original suffix stays readable while generation is pending');
  provider.resolve(sse('Answer to the edited question'));
  const done = doneOf(await eventsOf(first));
  assert.deepEqual(sent.map(turn => turn.content), ['First question', 'First answer', 'Revised second question']);
  const saved = messages(id); assert.equal(saved.length, 4); assert.deepEqual(saved.slice(0, 2), original.slice(0, 2));
  assert.equal(saved[2].id, original[2].id); assert.equal(saved[2].content, 'Revised second question'); assert.equal(saved[3].content, 'Answer to the edited question');
  const archive = await jsonOf(await call(`conversations/${id}/revisions/${done.revisionId}`));
  assert.deepEqual(archive.messages.map(message => message.content), original.slice(2).map(message => message.content));
  const chat = (await jsonOf(await call('conversations/' + id))).conversation;
  assert.equal(chat.title, 'Original title'); assert.ok(chat.pinned_at > 0);
});

test('editing keeps the original attachment context without copying it into the editable prompt text', async () => {
  const attachment = '\n\n<attached_document name="notes.txt">\nSaved document contents\n</attached_document>';
  const id = seed('attachment', { turns: ['Old question' + attachment, 'Old answer'] }); let sent;
  globalThis.fetch = async (url, options) => { sent = JSON.parse(options.body).input; return sse(); };
  doneOf(await eventsOf(await call('chat', 'POST', request(id, 'edit', id + '-m0', { prompt: 'New question' }))));
  assert.equal(sent.at(-1).content, withUntrustedDocuments('New question' + attachment));
  const message = (await jsonOf(await call('conversations/' + id))).messages[0];
  assert.equal(message.prompt_text, 'New question'); assert.equal(message.content, 'New question' + attachment);
});

test('provider failure and request cancellation preserve existing messages and consume no fake successful response', async () => {
  const id = seed(), original = messages(id);
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  const failedBody = request(id, 'edit', id + '-m0');
  const failure = await eventsOf(await call('chat', 'POST', failedBody));
  assert.ok(failure.some(event => event.type === 'error')); assert.equal(failure.some(event => event.type === 'done'), false);
  assert.deepEqual(messages(id), original); assert.equal(count('conversation_revisions'), 0);
  assert.equal(sqlite.prepare('SELECT status FROM usage').get().status, 'error');
  assert.equal((await call('chat', 'POST', failedBody)).status, 409);
  assert.equal(securityCount('server_error'),1);
  const controller = new AbortController(), begun = deferred();
  globalThis.fetch = async (url, options) => {
    begun.resolve();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  };
  const pending = await call('chat', 'POST', request(id, 'regenerate', id + '-m3'), {}, controller.signal);
  await begun.promise; controller.abort();
  const cancelled = await eventsOf(pending); assert.ok(cancelled.some(event => event.type === 'error')); assert.equal(cancelled.some(event => event.type === 'done'), false);
  assert.deepEqual(messages(id), original); assert.equal(count('conversation_revisions'), 0);
  assert.equal(sqlite.prepare('SELECT key FROM rate_limits WHERE key=?').get('chat:' + id), undefined);
  assert.equal(securityCount('server_error'),1,'user cancellation does not add a provider failure');
  assert.equal(securityCount('resource_spike'),2);
});

test('a failed replacement transaction rolls back archive and deletions while retaining measured billing', async () => {
  const id = seed(), original = messages(id);
  globalThis.fetch = async () => sse();
  beforeRun = (query, values) => { if (query.startsWith('INSERT INTO messages') && values[2] === 'assistant') throw new Error('Simulated commit failure'); };
  const events = await eventsOf(await call('chat', 'POST', request(id, 'edit', id + '-m0')));
  assert.ok(events.some(event => event.type === 'error')); assert.deepEqual(messages(id), original);
  assert.equal(count('conversation_revisions'), 0); assert.equal(count('conversation_revision_messages'), 0);
  const usage = sqlite.prepare('SELECT status,input_tokens,output_tokens,reserved_amount FROM usage').get();
  assert.equal(usage.status, 'error'); assert.equal(usage.input_tokens, 10); assert.equal(usage.output_tokens, 5); assert.ok(usage.reserved_amount > 0);
  assert.equal(securityCount('server_error'),1,'a persistence failure after provider completion is observable');
});

test('insufficient credit rejects a paid revision before contacting the provider or changing saved content', async () => {
  const id = seed(), original = messages(id); let calls = 0;
  fixtureBalance('alice',1);
  globalThis.fetch = async () => { calls++; return sse(); };
  const response = await call('chat', 'POST', request(id, 'edit', id + '-m2'));
  assert.equal(response.status, 402); assert.equal(calls, 0); assert.equal(count('usage'), 0);
  assert.deepEqual(messages(id), original); assert.equal(count('conversation_revisions'), 0);
  assert.equal(sqlite.prepare('SELECT key FROM rate_limits WHERE key=?').get('chat:' + id), undefined);
  assert.equal(securityCount('resource_spike'),0); assert.equal(securityCount('server_error'),0);
});

test('paid regeneration settles measured usage once and refunds cancellation before provider access', async () => {
  const id = seed(); let providerCalls = 0;
  env.BETA_MODE = 'false';
  const balance = () => sqlite.prepare("SELECT SUM(amount) total FROM wallet_events WHERE user_id='alice' AND mode='live'").get().total;
  globalThis.fetch = async () => { providerCalls++; return sse(); };
  const body = request(id, 'regenerate', id + '-m3');
  const completed = doneOf(await eventsOf(await call('chat', 'POST', body)));
  assert.equal(balance(), 100000000 - 20000);
  assert.equal(doneOf(await eventsOf(await call('chat', 'POST', body))).requestId, completed.requestId);
  assert.equal(providerCalls, 1); assert.equal(balance(), 100000000 - 20000);
  const preserved = messages(id), controller = new AbortController();
  beforeRun = query => { if (query.startsWith('UPDATE chat_operations SET user_message_id=')) controller.abort(); };
  const cancelled = await eventsOf(await call('chat', 'POST', request(id, 'edit', id + '-m0'), {}, controller.signal));
  assert.ok(cancelled.some(event => event.type === 'error')); assert.equal(cancelled.some(event => event.type === 'done'), false);
  assert.equal(providerCalls, 1); assert.equal(balance(), 100000000 - 20000);
  assert.deepEqual(messages(id), preserved);
  const usage = sqlite.prepare("SELECT input_tokens,output_tokens FROM usage WHERE status='error'").get();
  assert.equal(usage.input_tokens, 0); assert.equal(usage.output_tokens, 0);
  assert.equal(sqlite.prepare('SELECT key FROM rate_limits WHERE key=?').get('chat:' + id), undefined);
  assert.equal(securityCount('resource_spike'),1); assert.equal(securityCount('server_error'),0,'cancelled preparation is a controlled outcome');
});


const freeModelId = 'gemini-3.5-flash-lite';
const paidModelIds = ['gpt-6.1-sol', 'gpt-6-astra', 'claude-fable-5-1', 'gemini-4-argon'];
const googleReply = () => Response.json({ status: 'completed', outputs: [{ type: 'text', text: 'Real provider fixture answer' }], usage: { total_input_tokens: 10, total_output_tokens: 5, total_thought_tokens: 2 } });

test('all four paid models require live credit in beta and live modes; forged free flags cannot bypass access', async () => {
  fixtureBalance();
  Object.assign(env, { GEMINI_API_KEY: 'google-fixture', ANTHROPIC_API_KEY: 'anthropic-fixture' });
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; return sse(); };
  for (const beta of ['true', 'false']) {
    env.BETA_MODE = beta;
    for (const model of paidModelIds) {
      const result = await call('chat', 'POST', { model, prompt: 'Try a paid model' });
      assert.equal(result.status, 402, model + ' must require credit regardless of beta');
      assert.equal((await result.json()).code, 'PAID_CREDIT_REQUIRED');
    }
  }
  const forged = await call('chat', 'POST', { model: 'gpt-6.1-sol', prompt: 'Try a forged flag', free: true });
  assert.equal(forged.status, 400);
  assert.equal(providerCalls, 0); assert.equal(count('usage'), 0); assert.equal(count('chat_operations'), 0);
  assert.equal(count('messages'), 0); assert.equal(count('conversations'), 0);
});

test('test credits and another account credit never unlock paid inference', async () => {
  fixtureBalance();
  sqlite.prepare('INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('test-credit', 'alice', 'test', 'topup', 10000000000, 'test-only-credit', Date.now());
  sqlite.prepare('INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('bob-credit', 'bob', 'live', 'topup', 10000000000, 'bobs-credit', Date.now());
  const result = await call('chat', 'POST', { model: 'gpt-6.1-sol', prompt: 'No live credit' });
  assert.equal(result.status, 402); assert.equal((await result.json()).code, 'PAID_CREDIT_REQUIRED');
  assert.equal(count('usage'), 0);
});

test('signed-in Flash-Lite stays free without billing configuration in beta and live modes and retains daily limits', async () => {
  fixtureBalance();
  sqlite.prepare('DELETE FROM billing_config').run();
  env.GEMINI_API_KEY = 'google-fixture';
  let providerCalls = 0;
  globalThis.fetch = async (url, options) => {
    providerCalls++;
    assert.equal(JSON.parse(options.body).model, freeModelId);
    assert.match(url, /generativelanguage\.googleapis\.com/);
    return googleReply();
  };
  for (const beta of ['true', 'false']) {
    env.BETA_MODE = beta;
    doneOf(await eventsOf(await call('chat', 'POST', { model: freeModelId, prompt: 'A free question' })));
  }
  assert.equal(providerCalls, 2); assert.equal(count('wallet_events'), 2);
  assert.equal(sqlite.prepare("SELECT SUM(amount) n FROM wallet_events WHERE user_id='alice' AND mode='live'").get().n,0);
  const usage = sqlite.prepare('SELECT model,provider,status,input_tokens,output_tokens,reserved_amount FROM usage').all();
  assert.equal(usage.length, 2);
  for (const row of usage) {
    assert.equal(row.model, freeModelId); assert.equal(row.provider, 'google'); assert.equal(row.status, 'complete');
    assert.equal(row.input_tokens, 10); assert.equal(row.output_tokens, 7); assert.equal(row.reserved_amount, 21);
  }
  env.BETA_USER_DAILY_LIMIT_MICROS = '0';
  const blocked = await call('chat', 'POST', { model: freeModelId, prompt: 'Limit applies' });
  assert.equal(blocked.status, 429); assert.equal(providerCalls, 2); assert.equal(count('usage'), 2);
});

test('free Flash-Lite title generation uses an integer reservation despite fractional provider token rates', async () => {
  fixtureBalance();
  env.GEMINI_API_KEY = 'google-fixture';
  globalThis.fetch = async () => googleReply();
  doneOf(await eventsOf(await call('chat', 'POST', { model: freeModelId, prompt: 'A title test', generateTitle: true })));
  const row = sqlite.prepare('SELECT reserved_amount,status FROM usage').get();
  assert.equal(row.status, 'complete'); assert.ok(Number.isSafeInteger(row.reserved_amount));
  assert.equal(row.reserved_amount, 21 + Math.ceil(PROVIDER_INPUT_OVERHEAD_BYTES * .3 + 256 * 2.5));
  assert.equal(count('wallet_events'), 2);
  assert.equal(sqlite.prepare("SELECT SUM(amount) n FROM wallet_events WHERE user_id='alice' AND mode='live'").get().n,0);
  assert.equal(securityCount('resource_spike'),2,'the optional title is a separate reserved provider attempt');
});

test('supported model list stays explicit and retired models remain readable but cannot start new inference', async () => {
  env.GEMINI_API_KEY = 'google-fixture';
  for (const beta of ['true', 'false']) {
    env.BETA_MODE = beta;
    const boot = await jsonOf(await call('bootstrap'));
    assert.deepEqual(boot.models.map(model => model.id).sort(), [freeModelId, ...paidModelIds].sort());
    assert.deepEqual(boot.chatAccess, { freeModelId, freeAvailable: true, paidRequiresCredit: true });
  }
  const old = seed('old-model-chat');
  sqlite.prepare('UPDATE conversations SET model=? WHERE id=?').run('gpt-6-sol', old);
  assert.equal((await jsonOf(await call('conversations/' + old))).conversation.model, 'gpt-6-sol');
  const result = await call('chat', 'POST', { model: 'gpt-6-sol', prompt: 'An unavailable model', conversationId: old });
  assert.equal(result.status, 400); assert.equal((await result.json()).code, 'MODEL_NOT_AVAILABLE');
  assert.equal(count('usage'), 0);
});
