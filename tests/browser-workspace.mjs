import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const output = new URL('../.sites-runtime/browser-tests/', import.meta.url);
await mkdir(output, { recursive: true });
const source = await readFile(new URL('../lib/browser-workspace.ts', import.meta.url), 'utf8');
await writeFile(new URL('browser-workspace.mjs', output), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { normalizeBrowserUrl, browserlessEndpoint, handleBrowser, BROWSER_CAPTURE_PROGRAM } = await import(new URL('browser-workspace.mjs', output));
const schema = await readFile(new URL('../drizzle/0005_media_and_browser.sql', import.meta.url), 'utf8');

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  sqlite.exec('CREATE TABLE rate_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL)');
  const sql = { prepare(query) { let bindings = []; return {
    bind(...values) { bindings = values; return this; },
    async first() { return sqlite.prepare(query).get(...bindings) || null; },
    async all() { return { results: sqlite.prepare(query).all(...bindings) }; },
    async run() { sqlite.prepare(query).run(...bindings); return { success: true }; },
  }; } };
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sqlite.close(); });
  const call = (method = 'GET', owner = 'alice', id, body, env = {}) => handleBrowser(new Request('https://prism.test/api/browser/sessions' + (id ? '/' + id : ''), {
    method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  }), ['browser', 'sessions', ...(id ? [id] : [])], sql, owner, env);
  return { sqlite, call };
}

test('public-page URL and official provider endpoint validation reject local and credential-bearing destinations', () => {
  assert.equal(normalizeBrowserUrl('https://example.com/path?q=1#section'), 'https://example.com/path?q=1#section');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://localhost', 'https://service.internal', 'https://127.0.0.1', 'https://2130706433', 'https://0x7f000001', 'https://[::1]', 'https://user:password@example.com', 'https://example.com:8080', 'https://example.com\u0000']) assert.throws(() => normalizeBrowserUrl(url));
  assert.equal(browserlessEndpoint({}).href, 'https://production-sfo.browserless.io/function');
  assert.equal(browserlessEndpoint({ BROWSERLESS_ENDPOINT: 'https://production-ams.browserless.io' }).pathname, '/function');
  for (const endpoint of ['http://production-sfo.browserless.io', 'https://attacker.example', 'https://production-sfo.browserless.io.attacker.example', 'https://production-sfo.browserless.io/function?token=other', 'https://production-sfo.browserless.io/admin']) assert.throws(() => browserlessEndpoint({ BROWSERLESS_ENDPOINT: endpoint }));
  assert.doesNotThrow(() => new Function(BROWSER_CAPTURE_PROGRAM.replace('export default', 'return')));
});

test('missing Browserless credentials never fetch a page, reserve usage, or invent history', async t => {
  const { sqlite, call } = fixture(t);
  globalThis.fetch = async () => { throw new Error('Provider access must not occur'); };
  const response = await call('POST', 'alice', undefined, { url: 'https://example.com/' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'BROWSER_NOT_CONFIGURED');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM browser_sessions').get().n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n, 0);
});

test('real handler preserves rendered results, drops unsafe links, and isolates history and deletion by owner', async t => {
  const { sqlite, call } = fixture(t);
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, 'production-sfo.browserless.io');
    assert.equal(new URL(url).searchParams.get('token'), 'unit-test-secret');
    const request = JSON.parse(options.body);
    assert.equal(request.context.url, 'https://example.com/');
    assert.equal(JSON.stringify(request).includes('unit-test-secret'), false);
    return Response.json({ data: { url: 'https://example.com/', title: 'Example', text: 'Actual transport fixture text', links: [{ url: 'https://example.com/next', title: 'Next' }, { url: 'http://127.0.0.1/', title: 'Private' }] } });
  };
  const created = await call('POST', 'alice', undefined, { url: 'https://example.com/' }, { BROWSERLESS_API_TOKEN: 'unit-test-secret' });
  assert.equal(created.status, 201);
  const capture = await created.json();
  assert.equal(capture.text, 'Actual transport fixture text');
  assert.deepEqual(capture.links, [{ url: 'https://example.com/next', title: 'Next' }]);
  assert.equal(JSON.stringify(capture).includes('unit-test-secret'), false);
  assert.equal((await call('GET', 'bob', capture.id)).status, 404);
  assert.deepEqual((await (await call('GET', 'bob')).json()).sessions, []);
  assert.equal((await call('DELETE', 'bob')).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM browser_sessions').get().n, 1);
  assert.equal((await (await call('GET', 'alice', capture.id)).json()).text, capture.text);
  assert.equal((await call('DELETE', 'alice')).status, 200);
  assert.equal((await call('GET', 'alice', capture.id)).status, 404);
  assert.equal((await call('DELETE', 'alice')).status, 200);
});

test('provider errors release the active lock and do not save a successful-looking capture', async t => {
  const { sqlite, call } = fixture(t);
  globalThis.fetch = async () => new Response('Secret upstream diagnostics', { status: 500 });
  const response = await call('POST', 'alice', undefined, { url: 'https://example.com/' }, { BROWSERLESS_API_TOKEN: 'unit-test-secret' });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /Secret|unit-test-secret/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM browser_sessions').get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'browser:active:%'").get().n, 0);
});

test('daily visit cap blocks provider access and unsafe upstream redirects cannot enter history', async t => {
  const { sqlite, call } = fixture(t);
  const day = Math.floor(Date.now() / 86400000);
  sqlite.prepare('INSERT INTO rate_limits VALUES (?,5,?)').run('browser:day:user:alice:' + day, (day + 1) * 86400000);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ url: 'http://127.0.0.1/', title: 'Private', text: 'Private data' }); };
  assert.equal((await call('POST', 'alice', undefined, { url: 'https://example.com/' }, { BROWSERLESS_API_TOKEN: 'unit-test-secret' })).status, 429);
  assert.equal(calls, 0);
  const redirected = await call('POST', 'bob', undefined, { url: 'https://example.com/' }, { BROWSERLESS_API_TOKEN: 'unit-test-secret' });
  assert.equal(redirected.status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM browser_sessions').get().n, 0);
});
