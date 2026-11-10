import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const runtime = new URL('../.sites-runtime/api-resource-guards-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
for (const name of ['request-security', 'api-resource-guards']) {
  const source = (await readFile(new URL('../lib/' + name + '.ts', import.meta.url), 'utf8'))
    .replaceAll("'./request-security'", "'./request-security.mjs'");
  await writeFile(new URL(name + '.mjs', runtime), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}
const { allowAccountRead, allowPublicRead, createApiAdmissionController, checkReadiness } = await import(new URL('api-resource-guards.mjs', runtime));
const request = (path, options) => new Request('https://prism.test/api/' + path, options);
function database() {
  const native = new DatabaseSync(':memory:');
  native.exec('CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);');
  return { native, sql: { prepare(query) { let values = []; return {
    bind(...params) { values = params; return this; }, async first() { return native.prepare(query).get(...values) ?? null; },
  }; } } };
}

test('search quotas are atomic, account-isolated and cannot reset by varying search strings', async () => {
  const { native, sql } = database(), now = 123000;
  try {
    const attempts = await Promise.all(Array.from({ length: 35 }, (_, i) => allowAccountRead(sql, 'alice', request('search?q=' + i), now)));
    assert.equal(attempts.filter(Boolean).length, 30);
    assert.equal(await allowAccountRead(sql, 'bob', request('search?q=allowed'), now), true);
    assert.equal(await allowAccountRead(sql, 'alice', request('settings'), now), true);
    assert.equal(await allowAccountRead(sql, 'alice', request('search?q=boundary'), now + 59999), false);
    assert.equal(await allowAccountRead(sql, 'alice', request('search?q=reset'), now + 60000), true);
    assert.equal(native.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n, 3);
    assert.equal(native.prepare('SELECT count FROM rate_limits WHERE key=?').get('api:search:alice').count, 1);
  } finally { native.close(); }
});

test('read/download groups have finite allowances and random resource IDs share fixed keys', async () => {
  const { native, sql } = database(), now = 123000;
  try {
    for (let i = 0; i < 120; i++) assert.equal(await allowAccountRead(sql, 'alice', request(i % 2 ? 'files/' + i : 'media/' + i + '/content'), now), true);
    assert.equal(await allowAccountRead(sql, 'alice', request('artifacts/other'), now), false);
    for (let i = 0; i < 180; i++) assert.equal(await allowAccountRead(sql, 'alice', request('conversations/' + i), now), true);
    assert.equal(await allowAccountRead(sql, 'alice', request('usage'), now), false);
    assert.equal(await allowAccountRead(sql, 'alice', request('bootstrap'), now), true);
    assert.equal(await allowAccountRead(sql, 'alice', request('chat', { method: 'POST', body: '{}' }), now), true);
    assert.equal(native.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n, 2);
  } finally { native.close(); }
});

test('anonymous resource ceilings use a bounded number of rows independent of forged IPs and share tokens', async () => {
  const { native, sql } = database(), now = 123000;
  try {
    for (let i = 0; i < 600; i++) {
      const token = i.toString(16).padStart(64, '0');
      assert.equal(await allowPublicRead(sql, request('public-shares/' + token, { headers: { 'x-forwarded-for': '1.2.3.' + i } }), now), true);
    }
    assert.equal(await allowPublicRead(sql, request('public-shares/' + 'a'.repeat(64)), now), false);
    assert.equal(await allowPublicRead(sql, request('guest/bootstrap'), now), true);
    assert.equal(await allowPublicRead(sql, request('upgrade'), now), true);
    assert.equal(await allowPublicRead(sql, request('public-shares/' + 'a'.repeat(64)), now + 60000), true);
    assert.equal(native.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n, 3);
    assert.deepEqual(native.prepare('SELECT key FROM rate_limits ORDER BY key').all().map(row => row.key), ['api:public:guest-bootstrap', 'api:public:share', 'api:public:upgrade']);
  } finally { native.close(); }
});

test('simultaneous upload reservations use enforced sizes even when Content-Length lies', () => {
  const gate = createApiAdmissionController();
  const upload = () => request('media/reference', { method: 'POST', body: 'x', headers: { 'content-length': '1' } });
  const releases = [gate.acquire(upload()), gate.acquire(upload()), gate.acquire(upload())];
  releases.forEach(release => assert.equal(typeof release, 'function'));
  assert.equal(gate.acquire(upload()), null);
  releases[0](); releases[0](); // A repeated finally must not free someone else's allocation.
  const replacement = gate.acquire(upload()); assert.equal(typeof replacement, 'function');
  assert.equal(gate.acquire(upload()), null);
  releases[1](); releases[2](); replacement();
  const again = gate.acquire(upload()); assert.equal(typeof again, 'function'); again();
});

test('admission limits concurrent API preparations while public pages remain accessible', () => {
  const gate = createApiAdmissionController({ maxRequests: 2 });
  const first = gate.acquire(request('search')), second = gate.acquire(request('health/ready'));
  assert.equal(gate.acquire(request('files')), null);
  assert.equal(typeof gate.acquire(new Request('https://prism.test/')), 'function');
  first(); second(); assert.equal(typeof gate.acquire(request('files')), 'function');
});

test('readiness requests coalesce, cache only health state, and require current storage/provider configuration', async () => {
  let complete, batches = 0;
  const sql = { prepare: query => query, batch() { batches++; return new Promise(resolve => { complete = resolve; }); } };
  const env = { DB: sql, BUCKET: {}, GEMINI_API_KEY: 'fixture' };
  const probes = Array.from({ length: 20 }, () => checkReadiness(env));
  await Promise.resolve(); assert.equal(batches, 1);
  complete([]);
  assert.deepEqual(await Promise.all(probes), Array.from({ length: 20 }, () => ({ status: 'ready', service: 'open-prism' })));
  assert.equal((await checkReadiness(env)).status, 'ready'); assert.equal(batches, 1);
  assert.deepEqual(await checkReadiness({ ...env, BUCKET: undefined }), { status: 'unavailable', code: 'STORAGE_NOT_READY' });
  assert.deepEqual(await checkReadiness({ ...env, GEMINI_API_KEY: undefined }), { status: 'unavailable', code: 'PROVIDER_NOT_READY' });
});

test('a stalled readiness batch has a bounded response deadline without spawning replacement batches', async () => {
  let complete, batches = 0;
  const sql = { prepare: query => query, batch() { batches++; return new Promise(resolve => { complete = resolve; }); } };
  const env = { DB: sql, BUCKET: {}, GEMINI_API_KEY: 'fixture' };
  assert.deepEqual(await checkReadiness(env, 5), { status: 'unavailable', code: 'DATABASE_NOT_READY' });
  assert.deepEqual(await checkReadiness(env, 5), { status: 'unavailable', code: 'DATABASE_NOT_READY' });
  assert.equal(batches, 1);
  complete([]); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await checkReadiness(env), { status: 'ready', service: 'open-prism' });
});
