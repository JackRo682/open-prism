import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const runtime = new URL('../.sites-runtime/guest-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
await writeFile(new URL('context.mjs', runtime), 'export const env = {};');
const modules = ['models', 'provider', 'billing-contract','billing', 'beta', 'regenerate-style', 'guest-chat', 'security-monitoring'];
for (const name of modules) {
  let source = await readFile(new URL('../lib/' + name + '.ts', import.meta.url), 'utf8');
  for (const dependency of modules) source = source.replaceAll("'./" + dependency + "'", "'./" + dependency + ".mjs'");
  source = source.replaceAll("'cloudflare:workers'", "'./context.mjs'");
  await writeFile(new URL(name + '.mjs', runtime), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}
const { handleGuest, GUEST_POLICY } = await import(new URL('guest-chat.mjs', runtime));
const schema = (await Promise.all((await readdir(new URL('../drizzle/', import.meta.url))).filter(name=>name.endsWith('.sql')).sort().map(name =>
  readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')))).join('\n');

const events = response => response.text().then(text => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))));
const successStream = (text = 'A real provider test response.') => new Response([
  { event_type: 'interaction.start', interaction: { id: 'interaction-test', status: 'in_progress' } },
  { event_type: 'step.start', step: { type: 'model_output', content: [] } },
  { event_type: 'step.delta', delta: { type: 'text', text } },
  { event_type: 'interaction.completed', interaction: { status: 'completed', usage: { total_input_tokens: 12, total_output_tokens: 8, total_thought_tokens: 3 } } },
].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });

function fixture() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(schema);
  const sql = { prepare(query) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(query).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(query).all(...values) }; },
      _run() { return { success: true, meta: sqlite.prepare(query).run(...values) }; },
      async run() { return this._run(); },
    };
  }, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const results=statements.map(statement=>statement._run()); sqlite.exec('COMMIT'); return results; }
    catch(error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const environment = { OPENAI_API_KEY: 'guest-signing-test-only-key', GEMINI_API_KEY: 'guest-gemini-test-only-key' };
  const originalFetch = globalThis.fetch, calls = [];
  let provider = async () => successStream();
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(options.headers['x-goog-api-key'], environment.GEMINI_API_KEY);
    assert.equal(options.headers.Authorization, undefined);
    calls.push({ url, options, body: JSON.parse(options.body) });
    return provider(url, options);
  };
  const request = (path, method = 'GET', body, options = {}) => {
    const headers = new Headers({ 'sec-fetch-site': 'same-origin' });
    if (options.origin !== null) headers.set('origin', options.origin ?? 'https://prism.test');
    if (options.ip !== null) headers.set('cf-connecting-ip', options.ip ?? '203.0.113.20');
    if (options.cookie) headers.set('cookie', options.cookie);
    if (body !== undefined) headers.set('content-type', 'application/json');
    for (const [key, value] of Object.entries(options.headers ?? {})) value === null ? headers.delete(key) : headers.set(key, value);
    return new Request('https://prism.test/api/' + path, {
      method, headers, signal: options.signal,
      ...(body === undefined ? {} : { body: options.raw ? body : JSON.stringify(body) }),
    });
  };
  const call = (path, method = 'GET', body, options = {}) => handleGuest(request(path, method, body, options), path.split('/'), sql, environment);
  const bootstrap = async (options = {}) => {
    const response = await call('guest/bootstrap', 'GET', undefined, options);
    return { response, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? options.cookie };
  };
  const send = (cookie, body = {}, options = {}) => call('guest/chat', 'POST', { requestId: crypto.randomUUID(), prompt: 'Explain this clearly.', ...body }, { cookie, ...options });
  const seed = (overrides = {}) => sqlite.prepare('INSERT INTO usage (id,user_id,model,provider,status,created_at,rate_snapshot,reserved_amount) VALUES (?,?,?,?,?,?,?,?)').run(
    overrides.id ?? crypto.randomUUID(), overrides.owner ?? 'guest:fixture', overrides.model ?? GUEST_POLICY.model, overrides.provider ?? 'google', overrides.status ?? 'complete',
    overrides.createdAt ?? Date.now(), overrides.snapshot ?? 'beta:guest:v1:fixture', overrides.amount ?? 1,
  );
  return { sqlite, sql, environment, calls, request, call, bootstrap, send, seed,
    setProvider(fn) { provider = fn; },
    close() { globalThis.fetch = originalFetch; sqlite.close(); },
  };
}

test('bootstrap issues a signed private cookie and returns configured capabilities without any secret or stored content', async () => {
  const f = fixture();
  try {
    const { response, data, cookie } = await f.bootstrap({ origin: null });
    assert.equal(response.status, 200); assert.equal(data.available, true); assert.equal(data.remaining, 5);
    assert.deepEqual(data.model, { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', provider: 'google' }); assert.equal(data.maxPromptBytes, 4000);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('set-cookie'), /^__Host-prism-guest=.*; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/);
    assert.equal((await f.bootstrap({ cookie })).response.headers.get('set-cookie'), null);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
    assert.equal(f.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(data), /guest-(?:gemini|signing)-test-only-key|203\.0\.113|beta:guest|guest:/);
    assert.equal(await f.call('conversations'), null);
    assert.equal((await f.call('guest/unknown')).status, 404);
  } finally { f.close(); }
});

test('missing credentials, disabled guest service, or unavailable database fail closed without inference', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.bootstrap();
    // The legacy signing key cannot act as an inference fallback.
    delete f.environment.GEMINI_API_KEY;
    assert.equal((await f.bootstrap()).response.status, 503);
    assert.equal((await f.send(cookie)).status, 503);
    f.environment.GEMINI_API_KEY = 'guest-gemini-test-only-key'; f.environment.GUEST_CHAT_ENABLED = 'false';
    assert.equal((await f.bootstrap()).data.available, false);
    delete f.environment.GUEST_CHAT_ENABLED;
    const response = await handleGuest(f.request('guest/bootstrap'), ['guest', 'bootstrap'], undefined, f.environment);
    assert.equal(response.status, 503);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('Gemini-only installations work and an existing signing key preserves sessions across Gemini credential rotation', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.bootstrap();
    await events(await f.send(cookie));
    const original = f.sqlite.prepare('SELECT user_id,rate_snapshot FROM usage').get();
    f.environment.GEMINI_API_KEY = 'rotated-gemini-test-only-key';
    const reload = await f.bootstrap({ cookie });
    assert.equal(reload.response.headers.get('set-cookie'), null);
    assert.equal(reload.data.remaining, 4);
    assert.equal((await events(await f.send(cookie))).at(-1).type, 'done');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage WHERE user_id=? AND rate_snapshot=?').get(original.user_id, original.rate_snapshot).n, 2);
    delete f.environment.OPENAI_API_KEY;
    const geminiOnly = await f.bootstrap();
    assert.equal(geminiOnly.data.available, true);
    assert.equal((await events(await f.send(geminiOnly.cookie))).at(-1).type, 'done');
    assert.equal(f.calls.length, 3);
  } finally { f.close(); }
});

test('origin checks and signed sessions prevent cross-origin, missing-origin, forged, and expired requests', async t => {
  const f = fixture();
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  try {
    const { cookie } = await f.bootstrap();
    for (const options of [{ origin: 'https://other.test' }, { origin: null }, { origin: 'null' }, { headers: { 'sec-fetch-site': 'cross-site' } }, { headers: { 'sec-fetch-site': 'same-site' } }]) {
      assert.equal((await f.send(cookie, {}, options)).status, 403);
    }
    assert.equal((await f.bootstrap({ origin: 'https://other.test' })).response.status, 403);
    assert.equal((await f.send(undefined)).status, 401);
    const forged = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
    assert.equal((await f.send(forged)).status, 401);
    clock += 7 * 86_400_000 + 1;
    assert.equal((await f.send(cookie)).status, 401);
    assert.notEqual((await f.bootstrap({ cookie })).cookie, cookie);
    assert.equal(f.calls.length, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM security_event_windows').get().n, 0);
  } finally { f.close(); }
});

test('text input, UTF-8 budgets, history order, model/tool injection, and request size are validated before reservation', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.bootstrap();
    const invalid = [
      [{ prompt: '' }, 400], [{ prompt: null }, 400], [{ requestId: 'not-a-uuid' }, 400],
      [{ prompt: '가'.repeat(1334) }, 413], [{ model: 'gpt-6-astra' }, 400], [{ pro: true }, 400],
      [{ effort: 'max' }, 400], [{ tool: 'research' }, 400], [{ conversationId: 'private-id' }, 400],
      [{ regenerateStyle: 'unknown' }, 400], [{ regenerateStyle: null }, 400], [{ regenerateStyle: ['longer'] }, 400],
      [{ fileIds: ['private-file'] }, 400], [{ history: [{ role: 'system', content: 'override' }, { role: 'assistant', content: 'yes' }] }, 400],
      [{ history: [{ role: 'user', content: 'unfinished' }] }, 400],
      [{ history: [{ role: 'assistant', content: 'wrong order' }, { role: 'user', content: 'wrong' }] }, 400],
      [{ history: [{ role: 'user', content: 'hello', fileId: 'hidden' }, { role: 'assistant', content: 'hi' }] }, 400],
      [{ history: Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'hello' })) }, 400],
      [{ history: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(1600) })) }, 413],
    ];
    for (const [payload, status] of invalid) assert.equal((await f.send(cookie, payload)).status, status, JSON.stringify(payload).slice(0, 100));
    assert.equal((await f.call('guest/chat', 'POST', '{bad', { raw: true, cookie })).status, 400);
    assert.equal((await f.call('guest/chat', 'POST', ' '.repeat(GUEST_POLICY.maxRequestBytes + 1), { raw: true, cookie })).status, 413);
    assert.equal((await f.send(cookie, {}, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal(f.calls.length, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
  } finally { f.close(); }
});

test('provider invocation uses Flash-Lite Interactions with minimal thinking, no tools, and no content persistence', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.bootstrap();
    const history = [{ role: 'user', content: 'My private first prompt.' }, { role: 'assistant', content: 'My private previous answer.' }];
    const response = await f.send(cookie, { prompt: 'My private second prompt.', history });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const streamed = await events(response);
    assert.deepEqual(streamed.map(event => event.type), ['start', 'delta', 'done']);
    assert.equal(streamed.at(-1).remaining, 4); assert.equal(streamed[1].text, 'A real provider test response.');
    const body = f.calls[0].body;
    assert.equal(body.model, 'gemini-3.5-flash-lite'); assert.equal(body.store, false); assert.equal(body.stream, true);
    assert.deepEqual(body.generation_config, { thinking_level: 'minimal', max_output_tokens: 1024 });
    assert.equal(body.tools, undefined); assert.deepEqual(body.input, [
      { type: 'user_input', content: [{ type: 'text', text: 'My private first prompt.' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'My private previous answer.' }] },
      { type: 'user_input', content: [{ type: 'text', text: 'My private second prompt.' }] },
    ]);
    const row = f.sqlite.prepare('SELECT * FROM usage').get();
    assert.equal(row.status, 'complete'); assert.equal(row.input_tokens, 12); assert.equal(row.output_tokens, 11);
    // ceil(12 * 0.30 + (8 answer + 3 thinking) * 2.50) micro-USD.
    assert.equal(row.reserved_amount, 32); assert.equal(row.model, 'gemini-3.5-flash-lite'); assert.equal(row.provider, 'google');
    assert.match(row.user_id, /^guest:[a-f0-9]{64}$/); assert.match(row.rate_snapshot, /^beta:guest:v1:[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(row), /private|203\.0\.113|guest-(?:gemini|signing)-test-only-key|real provider/);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM conversations').get().n, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM files').get().n, 0);
  } finally { f.close(); }
});

test('a completed Google JSON interaction records real answer and thinking usage at the Flash-Lite rate', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.bootstrap();
    f.setProvider(async () => Response.json({
      id: 'interaction-json-test', status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Google JSON answer.' }] }],
      usage: { total_input_tokens: 20, total_output_tokens: 10, total_thought_tokens: 4 },
    }));
    const streamed = await events(await f.send(cookie));
    assert.deepEqual(streamed.map(event => event.type), ['start', 'delta', 'done']);
    assert.equal(streamed[1].text, 'Google JSON answer.');
    const row = f.sqlite.prepare('SELECT * FROM usage').get();
    assert.equal(row.input_tokens, 20); assert.equal(row.output_tokens, 14);
    assert.equal(row.reserved_amount, 41); assert.equal(row.status, 'complete');
  } finally { f.close(); }
});

test('idempotency survives network retries and does not permit a second provider call, even with case-varied UUIDs', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.bootstrap();
    const requestId = crypto.randomUUID();
    await events(await f.send(cookie, { requestId }));
    const duplicate = await f.send(cookie, { requestId: requestId.toUpperCase(), prompt: 'Changed prompt on the same ID.', regenerateStyle: 'shorter' });
    assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, 'DUPLICATE_REQUEST');
    assert.equal(f.calls.length, 1);
    // A different signed session owns its own ID namespace; one user cannot
    // occupy another user's idempotency key.
    const other = await f.bootstrap();
    await events(await f.send(other.cookie, { requestId }));
    assert.equal(f.calls.length, 2);
  } finally { f.close(); }
});

test('guest regeneration styles change only provider instructions and preserve actual usage accounting', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.bootstrap(), reserved = [];
    f.setProvider(async () => { reserved.push(f.sqlite.prepare("SELECT reserved_amount FROM usage WHERE status='pending'").get().reserved_amount); return successStream(); });
    const history = [{ role: 'user', content: 'Earlier question.' }, { role: 'assistant', content: 'Earlier answer.' }];
    const styles = ['longer', 'shorter', 'no_personalization', 'retry'];
    for (const style of styles) {
      const streamed = await events(await f.send(cookie, { prompt: 'Explain the current question.', history, regenerateStyle: style }));
      assert.equal(streamed.at(-1).type, 'done');
      const body = f.calls.at(-1).body;
      assert.deepEqual(body.input.slice(0, -1), [
        { type: 'user_input', content: [{ type: 'text', text: 'Earlier question.' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'Earlier answer.' }] },
      ]);
      const prompt = body.input.at(-1).content[0].text;
      if (style === 'longer' || style === 'shorter') {
        assert.ok(prompt.startsWith('Explain the current question.\n\n'));
        assert.match(prompt, new RegExp(style === 'longer' ? 'longer, more detailed' : 'shorter, more concise'));
      } else assert.equal(prompt, 'Explain the current question.');
      assert.equal(body.model, 'gemini-3.5-flash-lite'); assert.equal(body.generation_config.max_output_tokens, 1024); assert.equal(body.tools, undefined);
    }
    assert.ok(reserved[0] > reserved[3]); assert.ok(reserved[1] > reserved[3]); assert.equal(reserved[2], reserved[3]);
    assert.equal(f.calls.length, 4);
    const rows = f.sqlite.prepare('SELECT status,input_tokens,output_tokens,reserved_amount FROM usage').all();
    assert.equal(rows.length, 4); assert.ok(rows.every(row => row.status === 'complete' && row.input_tokens === 12 && row.output_tokens === 11 && row.reserved_amount === 32));
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
  } finally { f.close(); }
});

test('five daily attempts persist across reload and provider errors retain reservation without synthetic answers', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.bootstrap();
    f.setProvider(async () => new Response('{}', { status: 429 }));
    for (let i = 0; i < 5; i++) {
      const streamed = await events(await f.send(cookie));
      assert.deepEqual(streamed.map(event => event.type), ['start', 'error']);
      assert.equal(streamed.at(-1).code, 'GUEST_PROVIDER_ERROR');
    }
    const reload = await f.bootstrap({ cookie }); assert.equal(reload.data.remaining, 0);
    const exhausted = await f.send(cookie); assert.equal(exhausted.status, 429);
    assert.equal((await exhausted.json()).code, 'GUEST_LIMIT_REACHED');
    assert.ok(Number(exhausted.headers.get('retry-after')) > 0);
    assert.equal(f.calls.length, 5);
    assert.equal(f.sqlite.prepare("SELECT SUM(event_count) n FROM security_event_windows WHERE category='resource_spike'").get().n,5);
    assert.equal(f.sqlite.prepare("SELECT SUM(event_count) n FROM security_event_windows WHERE category='server_error'").get().n,5);
    const rows = f.sqlite.prepare('SELECT status,reserved_amount,error FROM usage').all();
    assert.ok(rows.every(row => row.status === 'error' && row.reserved_amount > 0 && row.error === 'GUEST_PROVIDER_ERROR'));
  } finally { f.close(); }
});

test('clearing cookies cannot reset the network allowance; IPv6 addresses in one /64 share it', async () => {
  const f = fixture();
  try {
    const first = await f.bootstrap({ ip: '2001:db8:1234:abcd::1' });
    await events(await f.send(first.cookie, {}, { ip: '2001:db8:1234:abcd::1' }));
    const snapshot = f.sqlite.prepare('SELECT rate_snapshot FROM usage').get().rate_snapshot;
    for (let i = 1; i < 20; i++) f.seed({ owner: 'guest:another-' + i, snapshot });
    const next = await f.bootstrap({ ip: '2001:db8:1234:abcd:1111:2222:3333:4444' });
    assert.equal(next.data.remaining, 0); assert.notEqual(next.cookie, first.cookie);
    assert.equal((await f.send(next.cookie, {}, { ip: '2001:db8:1234:abcd::2' })).status, 429);
    assert.equal((await f.bootstrap({ ip: '2001:db8:1234:abce::1' })).data.remaining, 5);
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test('an absent or malformed trusted network address falls into a shared capped bucket and ignores spoofed forwarding headers', async () => {
  const f = fixture();
  try {
    const first = await f.bootstrap({ ip: null, headers: { 'x-forwarded-for': '198.51.100.1' } });
    await events(await f.send(first.cookie, {}, { ip: null }));
    const snapshot = f.sqlite.prepare('SELECT rate_snapshot FROM usage').get().rate_snapshot;
    for (let i = 1; i < 20; i++) f.seed({ owner: 'guest:unknown-' + i, snapshot });
    const next = await f.bootstrap({ ip: null, headers: { 'x-forwarded-for': '198.51.100.200', 'x-real-ip': '198.51.100.201' } });
    assert.equal(next.data.remaining, 0);
    assert.equal((await f.send(next.cookie, {}, { ip: null, headers: { 'x-forwarded-for': '198.51.100.202' } })).status, 429);
    assert.equal((await f.bootstrap({ ip: 'not-an-ip' })).data.remaining, 0);
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test('guest daily budget and request caps and the existing shared beta lifetime ceiling block provider access', async () => {
  for (const mode of ['daily-budget', 'daily-count', 'beta-lifetime']) {
    const f = fixture();
    try {
      const { cookie } = await f.bootstrap();
      // Records created before the Gemini switch still consume the same caps.
      if (mode === 'daily-budget') f.seed({ model: 'gpt-6.1-sol', provider: 'openai', amount: GUEST_POLICY.siteDailyBudgetMicros });
      if (mode === 'daily-count') for (let i = 0; i < GUEST_POLICY.siteDailyRequests; i++) f.seed({ model: 'gpt-6.1-sol', provider: 'openai', owner: 'guest:count-' + i });
      if (mode === 'beta-lifetime') f.seed({ owner: 'signed-in-user', snapshot: 'beta:v1', amount: GUEST_POLICY.betaLifetimeBudgetMicros, createdAt: Date.now() - 86_400_000 });
      const response = await f.send(cookie);
      assert.equal(response.status, mode === 'beta-lifetime' ? 503 : 429, mode);
      const bootstrap = await f.bootstrap({ cookie });
      assert.equal(bootstrap.data.remaining, 0, mode);
      if (mode === 'beta-lifetime') {
        const result = await response.json();
        assert.equal(result.code, 'GUEST_SITE_LIMIT'); assert.equal(result.limitKind, 'site'); assert.equal(result.resetsAt, null);
        assert.equal(response.headers.get('retry-after'), null);
        assert.equal(bootstrap.data.available, false); assert.equal(bootstrap.data.resetsAt, null); assert.equal(bootstrap.data.limitKind, 'site');
        assert.doesNotMatch(result.error + bootstrap.data.error, /로그인|내일|초기화/);
      } else assert.ok(Number.isFinite(Date.parse(bootstrap.data.resetsAt)));
      assert.equal(f.calls.length, 0, mode);
    } finally { f.close(); }
  }
});

test('simultaneous requests cannot exceed a session allowance or execute a duplicate twice', async () => {
  for (const sameId of [false, true]) {
    const f = fixture(); let release;
    try {
      const { cookie } = await f.bootstrap();
      f.setProvider(() => new Promise(resolve => { release = () => resolve(successStream()); }));
      const requestId = crypto.randomUUID();
      const responses = await Promise.all([f.send(cookie, { requestId }), f.send(cookie, { requestId: sameId ? requestId : crypto.randomUUID() })]);
      assert.deepEqual(responses.map(response => response.status).sort(), sameId ? [200, 409] : [200, 429]);
      assert.equal(f.calls.length, 1); assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 1);
      release(); await events(responses.find(response => response.status === 200));
    } finally { release?.(); f.close(); }
  }
});

test('network and global active-job limits apply across different sessions', async () => {
  for (const mode of ['network', 'global']) {
    const f = fixture(); const releases = [], responses = [];
    try {
      f.setProvider(() => new Promise(resolve => releases.push(() => resolve(successStream()))));
      const count = mode === 'network' ? 3 : 5;
      for (let i = 0; i < count; i++) {
        const ip = mode === 'network' ? '203.0.113.50' : '203.0.113.' + (50 + i);
        const { cookie } = await f.bootstrap({ ip });
        responses.push(await f.send(cookie, {}, { ip }));
      }
      assert.deepEqual(responses.map(response => response.status), mode === 'network' ? [200, 200, 429] : [200, 200, 200, 200, 429]);
      assert.equal(f.calls.length, count - 1);
      releases.forEach(release => release());
      await Promise.all(responses.filter(response => response.status === 200).map(events));
    } finally { releases.forEach(release => release()); f.close(); }
  }
});

test('a stale request releases its concurrency lease without erasing daily charges or requiring an in-memory lock', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.bootstrap();
    await events(await f.send(cookie));
    const row = f.sqlite.prepare('SELECT user_id,rate_snapshot FROM usage').get();
    f.seed({ owner: row.user_id, snapshot: row.rate_snapshot, status: 'pending', createdAt: Date.now() - GUEST_POLICY.timeoutMs - 16_000, amount: 1000 });
    assert.equal((await events(await f.send(cookie))).at(-1).type, 'done');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM usage WHERE status='pending'").get().n, 1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 3);
  } finally { f.close(); }
});

test('request cancellation aborts the upstream fetch and retains a durable reservation', async () => {
  const f = fixture(), aborter = new AbortController(); let providerSignal;
  try {
    const { cookie } = await f.bootstrap();
    f.setProvider((_url, options) => new Promise((_resolve, reject) => {
      providerSignal = options.signal;
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
    }));
    const response = await f.send(cookie, {}, { signal: aborter.signal });
    assert.equal(response.status, 200); aborter.abort();
    const streamed = await events(response);
    assert.equal(providerSignal.aborted, true);
    assert.equal(streamed.at(-1).code, 'GUEST_ABORTED');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM security_event_windows WHERE category='server_error'").get().n,0);
    const row = f.sqlite.prepare('SELECT * FROM usage').get();
    assert.equal(row.status, 'error'); assert.ok(row.reserved_amount > 0);
  } finally { f.close(); }
});

test('guest SSE slow completion is visible after HTTP success and the counter follows reservation', async () => {
  const f=fixture(), realNow=Date.now;
  let now=Date.parse('2026-11-10T00:00:00Z'), release;
  Date.now=()=>now;
  try {
    const {cookie}=await f.bootstrap();
    f.setProvider(async()=>{
      const row=f.sqlite.prepare('SELECT status,reserved_amount FROM usage').get();
      assert.equal(row.status,'pending'); assert.ok(row.reserved_amount>0);
      await new Promise(resolve=>{release=resolve;});
      return successStream();
    });
    const response=await f.send(cookie);
    assert.equal(response.status,200);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM security_event_windows WHERE category='slow_request'").get().n,0);
    now+=120000; release();
    assert.equal((await events(response)).at(-1).type,'done');
    assert.equal(f.sqlite.prepare("SELECT event_count FROM security_event_windows WHERE category='slow_request'").get().event_count,1);
    const attempt=f.sqlite.prepare("SELECT * FROM security_event_windows WHERE category='resource_spike'").get();
    assert.equal(attempt.route,'/api/generation'); assert.equal(attempt.event_count,1);
    assert.doesNotMatch(JSON.stringify(f.sqlite.prepare('SELECT * FROM security_event_windows').all()),/guest:[a-f\d]{64}|beta:|203\.0\.113|Explain this/);
  } finally { release?.(); Date.now=realNow; f.close(); }
});

test('cancelling the response stream also stops upstream work and truncated streams never report success', async () => {
  const f = fixture(); let providerSignal;
  try {
    const { cookie } = await f.bootstrap();
    f.setProvider((_url, options) => new Promise((_resolve, reject) => {
      providerSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const response = await f.send(cookie); await response.body.cancel();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(providerSignal.aborted, true);
    assert.equal(f.sqlite.prepare('SELECT status FROM usage').get().status, 'error');
    f.setProvider(async () => new Response('data: {"event_type":"step.delta","delta":{"type":"text","text":"Partial answer"}}\n\n'));
    const partial = await events(await f.send(cookie));
    assert.deepEqual(partial.map(event => event.type), ['start', 'delta', 'error']);
    assert.equal(partial.at(-1).code, 'GUEST_PROVIDER_ERROR');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM usage WHERE status='complete'").get().n, 0);
  } finally { f.close(); }
});
