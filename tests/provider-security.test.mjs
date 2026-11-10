import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const directory = new URL('../.sites-runtime/provider-security-tests/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('context.mjs', directory), 'export const env = {};');
const modules = ['models', 'provider', 'billing-contract', 'billing', 'beta', 'workspace-tools', 'media-provider', 'media-workspace', 'image-validation', 'upload-validation', 'upload-security', 'request-lease', 'security-monitoring'];
for (const name of modules) {
  let source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8');
  source = source.replaceAll("'cloudflare:workers'", "'./context.mjs'");
  for (const dependency of modules) source = source.replaceAll(`'./${dependency}'`, `'./${dependency}.mjs'`);
  await writeFile(new URL(`${name}.mjs`, directory), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}
const { MODELS } = await import(new URL('models.mjs', directory));
const { invokeProvider, ProviderError } = await import(new URL('provider.mjs', directory));
const { downloadVideo, generateImage } = await import(new URL('media-provider.mjs', directory));
const { handleMedia } = await import(new URL('media-workspace.mjs', directory));
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const encoder = new TextEncoder();
const signal = () => new AbortController().signal;
const modelFor = provider => MODELS.find(model => model.provider === provider);
const invoke = (provider = 'openai', emit = () => {}) => invokeProvider(
  modelFor(provider), 'fixture-provider-key', [{ role: 'user', content: 'A bounded reply.' }],
  'medium', false, signal(), emit, 1024,
);
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));
const video = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
const videoJob = { provider: 'google', model: 'gemini-omni-1.1-flash', fileName: 'files/video-fixture' };

test('all text adapters reject redirects and discard upstream diagnostics', async () => {
  for (const provider of ['openai', 'anthropic', 'google']) {
    let cancelled = false;
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.redirect, 'manual', 'a provider key must never accompany an automatic redirect');
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode('fixture-secret-in-provider-body')); },
        cancel() { cancelled = true; },
      }), { status: 401 });
    };
    await assert.rejects(invoke(provider), error => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /key is invalid or expired/);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    });
    assert.equal(cancelled, true);
  }
});

test('fetch and JSON parser exceptions cannot expose credentials or response text', async () => {
  globalThis.fetch = async () => { throw new Error('Fetch failed: https://provider.example/?key=fixture-secret'); };
  await assert.rejects(invoke(), error => error instanceof ProviderError && !/fixture-secret|provider\.example/.test(error.message));
  globalThis.fetch = async () => new Response('{"private":"fixture-secret"', { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(invoke('google'), error => error instanceof ProviderError && /invalid response/.test(error.message) && !/fixture-secret/.test(error.message));
});

test('terminal provider failures do not await an unresolved upstream cancellation', async () => {
  const cases = [
    { name: 'HTTP error', provider: 'openai', status: 401, headers: {}, chunk: encoder.encode('fixture-secret'), expected: /key is invalid/ },
    { name: 'declared JSON size', provider: 'google', headers: { 'Content-Type': 'application/json', 'Content-Length': String(3 * 1024 * 1024) }, chunk: encoder.encode(' '), expected: /supported size limit/ },
    { name: 'declared SSE size', provider: 'openai', headers: { 'Content-Type': 'text/event-stream', 'Content-Length': String(9 * 1024 * 1024) }, chunk: encoder.encode(' '), expected: /supported size limit/ },
    { name: 'JSON reader size', provider: 'google', headers: { 'Content-Type': 'application/json' }, chunk: encoder.encode(' '.repeat(64 * 1024)), expected: /supported size limit/ },
    { name: 'SSE reader error', provider: 'openai', headers: { 'Content-Type': 'text/event-stream' }, chunk: encoder.encode('data: {"type":"error","message":"fixture-secret"}\n\n'), expected: /interrupted/ },
  ];
  for (const example of cases) {
    let cancelled = false, response, timer;
    globalThis.fetch = async () => {
      response = new Response(new ReadableStream({
        pull(controller) { controller.enqueue(example.chunk); },
        cancel() { cancelled = true; return new Promise(() => {}); },
      }), { status: example.status || 200, headers: example.headers });
      return response;
    };
    try {
      await Promise.race([
        assert.rejects(invoke(example.provider), error => error instanceof ProviderError && example.expected.test(error.message) && !/fixture-secret/.test(error.message)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(example.name + ' waited for cancellation')), 1000); }),
      ]);
      assert.equal(cancelled, true, example.name);
      assert.equal(response.body.locked, false, example.name + ' must release its reader');
    } finally { clearTimeout(timer); }
  }
});

test('Google JSON rejects invalid and truncated UTF-8 without emitting replacement text or diagnostics', async () => {
  const json = JSON.stringify({ status: 'completed', output_text: 'fixture-secret', usage: { input_tokens: 4, output_tokens: 5 } });
  const bytes = encoder.encode(json);
  const invalid = bytes.slice();
  invalid[json.indexOf('fixture-secret')] = 0xff;
  const truncated = new Uint8Array(bytes.length + 1);
  truncated.set(bytes); truncated[bytes.length] = 0xe2;
  for (const body of [invalid, truncated]) {
    let emitted = false;
    globalThis.fetch = async () => new Response(body, { headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(invoke('google', () => { emitted = true; }), error => error instanceof ProviderError && /invalid response/.test(error.message) && !/fixture-secret/.test(error.message));
    assert.equal(emitted, false);
  }
});

test('Google JSON is bounded while reading even without an honest Content-Length', async () => {
  for (const declaredLength of [undefined, '1']) {
    let cancelled = false, reads = 0;
    globalThis.fetch = async () => new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(encoder.encode(' '.repeat(64 * 1024))); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/json', ...(declaredLength ? { 'Content-Length': declaredLength } : {}) } });
    await assert.rejects(invoke('google'), /supported size limit/);
    assert.equal(cancelled, true);
    assert.ok(reads < 40, 'reading must stop at the byte bound, before the unlimited upstream ends');
  }
});

test('many individually small SSE events cannot exceed the aggregate response limit', async () => {
  let cancelled = false, emitted = false, reads = 0;
  const chunk = encoder.encode('data: ' + JSON.stringify({ type: 'diagnostic', padding: 'x'.repeat(64 * 1024) }) + '\n\n');
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(invoke('openai', () => { emitted = true; }), /supported size limit/);
  assert.equal(cancelled, true);
  assert.equal(emitted, false);
  assert.ok(reads < 140);
});

test('answer limits count UTF-8 bytes across deltas for every provider and cancel upstream', async () => {
  const text = '한'.repeat(20_000);
  for (const provider of ['openai', 'anthropic', 'google']) {
    let cancelled = false, emittedBytes = 0;
    const event = provider === 'openai' ? { type: 'response.output_text.delta', delta: text }
      : provider === 'google' ? { event_type: 'step.delta', delta: { type: 'text', text } }
        : { type: 'content_block_delta', delta: { type: 'text_delta', text } };
    const chunk = encoder.encode('data: ' + JSON.stringify(event) + '\n\n');
    globalThis.fetch = async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    await assert.rejects(invoke(provider, delta => { emittedBytes += encoder.encode(delta).length; }), /answer exceeded/);
    assert.ok(emittedBytes > 0 && emittedBytes <= 1024 * 1024);
    assert.equal(cancelled, true);
  }
});

test('video downloads reject nonstandard ports before following a redirect', async () => {
  for (const destination of ['https://storage.googleapis.com:8443/object', 'https://cdn.googleusercontent.com:444/object']) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { Location: destination } }); };
    await assert.rejects(downloadVideo({ GEMINI_API_KEY: 'fixture-provider-key' }, videoJob, signal()), error => error.code === 'INVALID_VIDEO_FILE');
    assert.equal(calls, 1, 'the redirected destination must not be contacted');
  }
});

test('permitted video storage redirects receive no provider credential', async () => {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    if (calls === 1) {
      assert.equal(options.headers['x-goog-api-key'], 'fixture-provider-key');
      return new Response(null, { status: 302, headers: { Location: 'https://storage.googleapis.com/fixture/video' } });
    }
    assert.equal(url, 'https://storage.googleapis.com/fixture/video');
    assert.deepEqual(options.headers, {});
    return new Response(video);
  };
  assert.deepEqual((await downloadVideo({ GEMINI_API_KEY: 'fixture-provider-key' }, videoJob, signal())).bytes, video);
  assert.equal(calls, 2);
});

test('generated image headers cannot request unbounded pixel allocation', async () => {
  for (const dimension of [0, 100_000]) {
    const bytes = png.slice();
    new DataView(bytes.buffer).setUint32(16, dimension);
    globalThis.fetch = async () => Response.json({ data: [{ b64_json: Buffer.from(bytes).toString('base64') }] });
    await assert.rejects(generateImage({ OPENAI_API_KEY: 'fixture-provider-key' }, { prompt: 'An image.' }, signal()), error => error.code === 'INVALID_MEDIA_OUTPUT');
  }
});

async function mediaFixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
  }
  t.after(() => sqlite.close());
  const sql = {
    prepare(query) {
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        async first() { return sqlite.prepare(query).get(...bindings) || null; },
        async all() { return { results: sqlite.prepare(query).all(...bindings) }; },
        async run() { return { success: true, meta: { changes: Number(sqlite.prepare(query).run(...bindings).changes) } }; },
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
  const env = { BETA_MODE: 'true', OPENAI_API_KEY: 'fixture-key', GEMINI_API_KEY: 'fixture-key', BUCKET: { async put() {}, async delete() {} } };
  const call = (path, method = 'GET', body) => handleMedia(new Request('https://prism.test/api/' + path, {
    method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  }), path.split('/'), sql, 'alice', env);
  const seedVideo = () => {
    const now = Date.now();
    sqlite.prepare("INSERT INTO usage (id,user_id,model,provider,status,created_at,rate_snapshot,reserved_amount) VALUES ('fixture-usage','alice','gemini-omni-1.1-flash','google','pending',?,'beta:media',1500000)").run(now);
    sqlite.prepare("INSERT INTO media_assets (id,user_id,kind,prompt,model,status,job,usage_id,created_at,updated_at) VALUES ('fixture-video','alice','video','A scene','gemini-omni-1.1-flash','processing',?,'fixture-usage',?,?)").run(JSON.stringify(videoJob), now, now);
  };
  return { sqlite, call, seedVideo };
}

test('unexpected media errors are redacted in both stored ledgers and API errors', async t => {
  const { sqlite, call } = await mediaFixture(t);
  globalThis.fetch = async () => { throw new Error('Transport exception with key=fixture-secret and private prompt'); };
  await assert.rejects(call('media', 'POST', { kind: 'image', prompt: 'A tree.' }), error => error.code === 'MEDIA_UNAVAILABLE' && !/fixture-secret|private prompt/.test(error.message));
  for (const table of ['usage', 'media_assets']) {
    const row = sqlite.prepare(`SELECT status,error FROM ${table}`).get();
    assert.equal(row.status, 'error');
    assert.doesNotMatch(row.error, /fixture-secret|private prompt/);
  }
  assert.equal(sqlite.prepare('SELECT reserved_amount FROM usage').get().reserved_amount, 150000, 'uncertain provider work must retain its reservation');
  sqlite.prepare("UPDATE media_assets SET error='legacy key=fixture-secret'").run();
  assert.doesNotMatch(await (await call('media')).text(), /fixture-secret/, 'historical raw diagnostics must not be replayed to clients');
});

test('video refresh redacts transport errors and cannot release a successor lock', async t => {
  const { sqlite, call, seedVideo } = await mediaFixture(t);
  seedVideo();
  let successorExpiry;
  globalThis.fetch = async () => {
    const current = sqlite.prepare("SELECT expires_at FROM rate_limits WHERE key='media-poll:fixture-video'").get();
    successorExpiry = current.expires_at + 60_000;
    // Simulate a later owner taking over an expired lease before the old finally runs.
    sqlite.prepare("UPDATE rate_limits SET expires_at=?,lease_token='successor-token' WHERE key='media-poll:fixture-video'").run(successorExpiry);
    throw new Error('Network exception: fixture-secret');
  };
  const response = await call('media/fixture-video/refresh', 'POST');
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /fixture-secret/);
  assert.equal(sqlite.prepare("SELECT status FROM media_assets WHERE id='fixture-video'").get().status, 'processing');
  assert.equal(sqlite.prepare("SELECT expires_at FROM rate_limits WHERE key='media-poll:fixture-video'").get().expires_at, successorExpiry);
});
