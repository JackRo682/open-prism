import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise real handlers and SQL against all migrations. The only boundaries
// replaced here are platform identity/storage and the external AI transport.
const runtime = new URL('../.sites-runtime/api-security-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
let sqlite, user, failQuery;
const objects = new Map(), originalFetch = globalThis.fetch;
const env = {};
globalThis.__apiSecurityTest = { env, getChatGPTUser: async () => user };
await writeFile(new URL('context.mjs', runtime), 'export const {env,getChatGPTUser}=globalThis.__apiSecurityTest;');
const modules = ['models','provider','billing','beta','workspace-settings','workspace-tools','media-provider','media-workspace','browser-workspace','scheduled-tasks','schedule-time','work-artifacts','guest-chat','guest-import','request-security','upload-security','api-resource-guards'];
for (const [source, target] of [...modules.map(name => ['lib/' + name + '.ts', name + '.mjs']), ['app/api/[...path]/route.ts', 'route.mjs']]) {
  let code = (await readFile(new URL('../' + source, import.meta.url), 'utf8'))
    .replaceAll("'cloudflare:workers'", "'./context.mjs'")
    .replaceAll("'../../chatgpt-auth'", "'./context.mjs'");
  for (const name of modules) code = code.replaceAll("'../../../lib/" + name + "'", "'./" + name + ".mjs'").replaceAll("'./" + name + "'", "'./" + name + ".mjs'");
  await writeFile(new URL(target, runtime), ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const route = await import(new URL('route.mjs', runtime));
const { boundedApiRequest, allowAccountMutation } = await import(new URL('request-security.mjs', runtime));
const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()
  .map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')));

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const migration of migrations) sqlite.exec(migration);
  // Isolated credits let security checks reach the attachment/storage boundary.
  sqlite.prepare('INSERT INTO billing_config (key,value,updated_at) VALUES (?,?,?)')
    .run('launch', JSON.stringify({ rates: { 'gpt-6.1-sol': { input: 1000, output: 2000 } }, refundPolicy: '', validityPolicy: '', registrationNumber: '', address: '', supportEmail: '' }), Date.now());
  sqlite.prepare('INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('initial-credit', 'alice', 'live', 'topup', 1000000000, 'isolated-credit', Date.now());
  failQuery = undefined; objects.clear();
  user = { userId: 'alice', email: 'alice@example.test' };
  for (const key of Object.keys(env)) delete env[key];
  env.BETA_MODE = 'true'; env.OPENAI_API_KEY = 'test-only-key';
  env.DB = {
    prepare(query) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async first() { failQuery?.(query, values); return sqlite.prepare(query).get(...values) ?? null; },
        async all() { failQuery?.(query, values); return { results: sqlite.prepare(query).all(...values) }; },
        async run() { failQuery?.(query, values); return { success: true, meta: { changes: Number(sqlite.prepare(query).run(...values).changes) } }; },
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
    async put(key, value) { objects.set(key, value); },
    async delete(key) { objects.delete(key); },
    async get(key) { return objects.has(key) ? { text: async () => objects.get(key) } : null; },
  };
  globalThis.fetch = async () => { throw new Error('Unexpected provider request'); };
});
afterEach(() => { globalThis.fetch = originalFetch; sqlite.close(); });

function request(path, method = 'POST', body = {}, extra = {}) {
  const headers = new Headers({ origin: 'https://prism.test', 'sec-fetch-site': 'same-origin' });
  if (body !== undefined && !(body instanceof FormData)) headers.set('content-type', 'application/json');
  for (const [name, value] of Object.entries(extra)) value === null ? headers.delete(name) : headers.set(name, value);
  return new Request('https://prism.test/api/' + path, {
    method, headers,
    ...(['GET', 'HEAD'].includes(method) || body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
}
const call = (path, method = 'POST', body = {}, headers) => route[method](request(path, method, body, headers));
const chat = (overrides = {}) => ({ model: 'gpt-6.1-sol', prompt: 'Please explain a rainbow.', ...overrides });
const events = async response => (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
const success = () => new Response([
  { type: 'response.output_text.delta', delta: 'A test answer.' },
  { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });

test('body boundaries cancel the actual source for oversized streaming uploads, without trusting Content-Length', async () => {
  for (const declared of [undefined, '1']) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(100001)); },
      cancel() { cancelled = true; },
    });
    const req = new Request('https://prism.test/api/chat', { method: 'POST', duplex: 'half', body,
      headers: { 'content-type': 'application/json', ...(declared ? { 'content-length': declared } : {}) } });
    await assert.rejects(() => boundedApiRequest(req), error => error.status === 413 && error.code === 'REQUEST_TOO_LARGE');
    assert.equal(cancelled, true);
    assert.equal(req.bodyUsed, true);
  }
});

test('stalled uploads have a deadline and aborting the request cancels its original body', async () => {
  for (const abort of [false, true]) {
    let cancelled = false;
    const controller = new AbortController();
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const req = new Request('https://prism.test/api/chat', { method: 'POST', duplex: 'half', body,
      signal: controller.signal, headers: { 'content-type': 'application/json' } });
    const reading = boundedApiRequest(req, abort ? 1000 : 10);
    if (abort) controller.abort();
    await assert.rejects(() => reading, error => error.status === 408 && error.code === (abort ? 'REQUEST_ABORTED' : 'REQUEST_TIMEOUT'));
    assert.equal(cancelled, true);
  }
});

test('bounded requests preserve their contents, identity headers, URL, and cancellation signal', async () => {
  const controller = new AbortController();
  const payload = JSON.stringify({ prompt: '한글 text', model: 'gpt-6.1-sol' });
  const req = new Request('https://prism.test/api/chat?test=1', { method: 'POST', body: payload, signal: controller.signal,
    headers: { 'content-type': 'application/json; charset = "UTF-8"', origin: 'https://prism.test', cookie: 'fixture-cookie=private', 'x-fixture-identity': 'alice' } });
  const bounded = await boundedApiRequest(req);
  assert.equal(bounded.url, req.url); assert.equal(bounded.method, 'POST');
  assert.equal(bounded.headers.get('cookie'), 'fixture-cookie=private');
  assert.equal(bounded.headers.get('x-fixture-identity'), 'alice');
  assert.equal(await bounded.text(), payload);
  controller.abort(); assert.equal(bounded.signal.aborted, true);
});

test('unexpected request-body failures log only fixed stage and exception-type labels', async () => {
  const originalWarn = console.warn, warnings = [];
  console.warn = value => { warnings.push(JSON.parse(value)); };
  try {
    const body = new ReadableStream({ start(controller) { controller.error(new TypeError('private-body fixture-secret')); } });
    const input = new Request('https://prism.test/api/chat', {
      method: 'POST', duplex: 'half', body, headers: { 'Content-Type': 'application/json' },
    });
    await assert.rejects(() => boundedApiRequest(input), error => error.code === 'INVALID_REQUEST_BODY'
      && error.status === 400 && !/private-body|fixture-secret/.test(error.message));
    assert.deepEqual(warnings, [{ event: 'api_request_body_failure', stage: 'read', exceptionType: 'TypeError' }]);
  } finally { console.warn = originalWarn; }
});

test('ambiguous encodings, form posts to JSON routes, malformed UTF-8, and invalid declared lengths fail before handlers', async () => {
  for (const [headers, code, status] of [
    [{ 'content-type': 'text/plain' }, 'UNSUPPORTED_CONTENT_TYPE', 415],
    [{ 'content-type': 'application/x-www-form-urlencoded' }, 'UNSUPPORTED_CONTENT_TYPE', 415],
    [{ 'content-encoding': 'gzip' }, 'UNSUPPORTED_CONTENT_ENCODING', 415],
    [{ 'content-type': 'application/json; charset=latin1' }, 'UNSUPPORTED_CHARSET', 415],
    [{ 'content-type': 'application/json;charset=utf-8;charset=latin1' }, 'UNSUPPORTED_CHARSET', 415],
    [{ 'content-length': '-1' }, 'INVALID_CONTENT_LENGTH', 400],
    [{ 'content-length': '100001' }, 'REQUEST_TOO_LARGE', 413],
  ]) {
    const response = await call('chat', 'POST', chat(), headers);
    assert.equal(response.status, status); assert.equal((await response.json()).code, code);
  }
  const invalid = new Request('https://prism.test/api/chat', { method: 'POST', body: new Uint8Array([0xc3, 0x28]),
    headers: { origin: 'https://prism.test', 'content-type': 'application/json' } });
  const response = await route.POST(invalid);
  assert.equal(response.status, 400); assert.equal((await response.json()).code, 'INVALID_UTF8');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM usage').get().n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n, 0);
});

test('account read quotas reject expensive queries before reaching data handlers and retain independent groups', async () => {
  sqlite.prepare('INSERT INTO rate_limits (key,count,expires_at) VALUES (?,?,?)').run('api:search:alice', 30, Date.now() + 60000);
  failQuery = query => { if (query.startsWith('SELECT c.id,c.title')) throw new Error('Search must not run after its quota'); };
  const blocked = await call('search?q=expensive', 'GET');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('Retry-After'), '60');
  assert.equal((await blocked.json()).code, 'ACCOUNT_READ_RATE_LIMIT');
  assert.equal((await call('settings', 'GET')).status, 200);
  sqlite.prepare('UPDATE rate_limits SET count=180 WHERE key=?').run('api:read:alice');
  assert.equal((await call('usage', 'GET')).status, 429);
  assert.equal((await call('bootstrap', 'GET')).status, 200);
  user = { userId: 'bob', email: 'bob@example.test' };
  assert.equal((await call('settings', 'GET')).status, 200);
});

test('anonymous share resource ceilings run before snapshot lookup and cannot be bypassed with another token', async () => {
  user = null;
  sqlite.prepare('INSERT INTO rate_limits (key,count,expires_at) VALUES (?,?,?)').run('api:public:share', 600, Date.now() + 60000);
  failQuery = query => { if (query.startsWith('SELECT title,snapshot')) throw new Error('Snapshot lookup must not run after quota'); };
  for (const token of ['a'.repeat(64), 'b'.repeat(64)]) {
    const response = await call('public-shares/' + token, 'GET');
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, 'PUBLIC_READ_RATE_LIMIT');
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n, 1);
  assert.equal((await call('health/live', 'GET')).status, 200);
});

test('account write quotas are atomic, isolated, bounded in row count, and expire without delaying reads', async () => {
  const now = Date.now();
  const reservations = await Promise.all(Array.from({ length: 125 }, () => allowAccountMutation(env.DB, 'alice', now)));
  assert.equal(reservations.filter(Boolean).length, 120);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n, 1);
  const blocked = await call('settings', 'PATCH', { memory: 'blocked' });
  assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal((await call('bootstrap', 'GET')).status, 200);
  assert.equal((await call('settings', 'GET')).status, 200);
  assert.equal(await allowAccountMutation(env.DB, 'bob', now), true);
  assert.equal(await allowAccountMutation(env.DB, 'alice', now + 60000), true);
  assert.equal(sqlite.prepare('SELECT count FROM rate_limits WHERE key=?').get('alice:api-write').count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE '%:api-write'").get().n, 2);
  assert.equal(sqlite.prepare('SELECT count FROM rate_limits WHERE key=?').get('api:read:alice').count, 1);
});

test('concurrent uploads cannot exceed 100 owned files and rejected uploads leave no orphaned object', async () => {
  const now = Date.now();
  for (let i = 0; i < 99; i++) sqlite.prepare('INSERT INTO files (id,user_id,name,key,size,type,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('file-' + i, 'alice', 'existing.txt', 'alice/existing-' + i, 1, 'text/plain', now);
  const upload = () => { const form = new FormData(); form.set('file', new File(['File text.'], 'notes.txt')); return call('files', 'POST', form); };
  const responses = await Promise.all([upload(), upload()]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM files WHERE user_id=?').get('alice').n, 100);
  assert.equal(objects.size, 1);
  const saved = await responses.find(response => response.ok).json();
  assert.equal(objects.has('alice/' + saved.id), true);
  user = { userId: 'bob', email: 'bob@example.test' };
  assert.equal((await call('files/' + saved.id, 'GET')).status, 404);
});

test('file uploads reject malformed text and multipart ambiguity without creating database rows or R2 objects', async () => {
  for (const [bytes, name] of [[new Uint8Array([0xc3, 0x28]), 'notes.txt'], ['plain\x1btext', 'notes.txt'], ['plain text', 'notes.pdf'], ['x'.repeat(131073), 'notes.txt']]) {
    const form = new FormData(); form.set('file', new File([bytes], name));
    assert.equal((await call('files', 'POST', form)).status, 400);
  }
  const form = new FormData(); form.append('file', new File(['one'], 'one.txt')); form.append('file', new File(['two'], 'two.txt'));
  assert.equal((await call('files', 'POST', form)).status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM files').get().n, 0);
  assert.equal(objects.size, 0);
});

test('HTML and source uploads remain inert text and all untrusted text downloads force attachment', async () => {
  const payload = '<script>fetch("https://attacker.test/")</script>';
  const form = new FormData(); form.set('file', new File([payload], 'example.html', { type: 'text/html' }));
  const created = await call('files', 'POST', form); assert.equal(created.status, 200);
  const file = await created.json(), downloaded = await call('files/' + file.id, 'GET');
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.match(downloaded.headers.get('Content-Disposition'), /^attachment; filename\*=UTF-8''example\.html$/);
  assert.equal(downloaded.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(downloaded.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.match(downloaded.headers.get('Content-Security-Policy'), /sandbox/);
  assert.equal(await downloaded.text(), payload);
});

test('wrong-owner object keys in owned database rows never cause storage reads or deletes', async () => {
  const now = Date.now();
  sqlite.prepare('INSERT INTO files (id,user_id,name,key,size,type,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('bad-file', 'alice', 'notes.txt', 'bob/private-file', 1, 'text/plain', now);
  sqlite.prepare("INSERT INTO media_assets (id,user_id,kind,prompt,model,status,object_key,mime_type,size,created_at,updated_at) VALUES ('bad-media','alice','reference','','','complete','bob/references/private','image/png',68,?,?)").run(now, now);
  sqlite.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('artifact-chat', 'alice', 'Artifacts', 'gpt-6.1-sol', now, now);
  sqlite.prepare('INSERT INTO work_artifacts (id,user_id,conversation_id,name,object_key,mime_type,size,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('bad-artifact', 'alice', 'artifact-chat', 'result.html', 'bob/artifacts/private', 'application/octet-stream', 1, now);
  let storageCalls = 0;
  env.BUCKET.get = async () => { storageCalls++; throw new Error('Wrong-owner read'); };
  env.BUCKET.delete = async () => { storageCalls++; throw new Error('Wrong-owner delete'); };
  for (const [path, method] of [['files/bad-file', 'GET'], ['files/bad-file', 'DELETE'], ['media/bad-media/content', 'GET'], ['media/bad-media', 'DELETE'], ['artifacts/bad-artifact', 'GET']]) {
    assert.equal((await call(path, method)).status, 404, path);
  }
  assert.equal((await call('chat', 'POST', chat({ fileIds: ['bad-file'] }))).status, 400);
  assert.equal((await call('media', 'POST', { kind: 'image', prompt: 'A tree', referenceId: 'bad-media' })).status, 404);
  assert.equal((await call('account/data', 'DELETE')).status, 409);
  assert.equal(storageCalls, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM files').get().n, 1);
});

test('media downloads reject unexpected stored content types before loading the object', async () => {
  const now = Date.now();
  sqlite.prepare("INSERT INTO media_assets (id,user_id,kind,prompt,model,status,object_key,mime_type,size,created_at,updated_at) VALUES ('unsafe-media','alice','reference','','','complete','alice/references/safe-key','text/html',68,?,?)").run(now, now);
  let calls = 0; env.BUCKET.get = async () => { calls++; throw new Error('Must reject metadata before storage'); };
  assert.equal((await call('media/unsafe-media/content', 'GET')).status, 415);
  assert.equal(calls, 0);
});
