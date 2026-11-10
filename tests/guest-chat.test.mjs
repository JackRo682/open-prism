import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const runtime = new URL('../.sites-runtime/guest-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
await writeFile(new URL('context.mjs', runtime), 'export const env = {};');
const modules = ['models', 'provider', 'billing', 'beta', 'guest-chat'];
for (const name of modules) {
  let source = await readFile(new URL('../lib/' + name + '.ts', import.meta.url), 'utf8');
  for (const dependency of modules) source = source.replaceAll("'./" + dependency + "'", "'./" + dependency + ".mjs'");
  source = source.replaceAll("'cloudflare:workers'", "'./context.mjs'");
  await writeFile(new URL(name + '.mjs', runtime), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}
const { handleGuest, GUEST_POLICY } = await import(new URL('guest-chat.mjs', runtime));
const { reserveBeta, reserveMedia, BETA_ACCOUNT_BUDGET_MICROS, BETA_GUEST_BUDGET_MICROS, BETA_TOTAL_BUDGET_MICROS } = await import(new URL('beta.mjs', runtime));
const schema = (await Promise.all(['0000_shallow_tony_stark.sql', '0002_omniscient_sinister_six.sql'].map(name =>
  readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')))).join('\n');

const events = response => response.text().then(text => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))));
const successStream = (text = 'A real provider test response.') => new Response([
  { type: 'response.output_text.delta', delta: text },
  { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 8 } } },
].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));

// Solve with Node's independent synchronous SHA-256 implementation, not the
// browser helper under test. This keeps tests fast without bypassing a proof.
function solveProof(challenge) {
  assert.equal(challenge.kind, 'proof-of-work');
  const whole = Math.floor(challenge.difficulty / 8), remainder = challenge.difficulty % 8;
  for (let candidate = 0; candidate < 4_194_304; candidate++) {
    const solution = candidate.toString(16);
    const digest = createHash('sha256').update(challenge.token + ':' + solution).digest();
    if (digest.subarray(0, whole).every(value => value === 0) && (!remainder || digest[whole] >> (8 - remainder) === 0))
      return { token: challenge.token, solution };
  }
  throw new Error('No proof found in the browser search bound');
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(schema);
  const sql = { prepare(query) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(query).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(query).all(...values) }; },
      async run() { return { success: true, meta: sqlite.prepare(query).run(...values) }; },
    };
  } };
  const environment = { OPENAI_API_KEY: 'guest-test-only-key', GUEST_SESSION_SIGNING_SECRET: 'c'.repeat(64) };
  const originalFetch = globalThis.fetch, calls = [], turnstileCalls = [];
  let provider = async () => successStream();
  let turnstile = async () => Response.json({ success: true, hostname: 'prism.test', action: 'guest_chat' });
  globalThis.fetch = async (url, options) => {
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.secret, environment.TURNSTILE_SECRET_KEY);
      assert.ok(options.signal instanceof AbortSignal);
      turnstileCalls.push({ url, options, body });
      return turnstile(url, options);
    }
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer ' + environment.OPENAI_API_KEY);
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
  const challenge = async (cookie, options = {}) => {
    const response = await call('guest/challenge', 'GET', undefined, { cookie, ...options });
    const data = await response.json();
    return { response, data, challenge: data.challenge };
  };
  const sendRaw = (cookie, body = {}, options = {}) => call('guest/chat', 'POST', { requestId: crypto.randomUUID(), prompt: 'Explain this clearly.', ...body }, { cookie, ...options });
  const send = async (cookie, body = {}, options = {}) => {
    if (options.autoProof === false || Object.hasOwn(body, 'proof') || Object.hasOwn(body, 'turnstileToken')) return sendRaw(cookie, body, options);
    const issued = await challenge(cookie, options);
    const proof = issued.challenge?.kind === 'proof-of-work' ? { proof: solveProof(issued.challenge) }
      : issued.challenge?.kind === 'turnstile' ? { turnstileToken: 'test-turnstile-token-' + crypto.randomUUID() } : {};
    return sendRaw(cookie, { ...proof, ...body }, options);
  };
  const seed = (overrides = {}) => sqlite.prepare('INSERT INTO usage (id,user_id,model,provider,status,created_at,rate_snapshot,reserved_amount) VALUES (?,?,?,?,?,?,?,?)').run(
    overrides.id ?? crypto.randomUUID(), overrides.owner ?? 'guest:fixture', overrides.model ?? GUEST_POLICY.model, overrides.provider ?? 'openai', overrides.status ?? 'complete',
    overrides.createdAt ?? Date.now(), overrides.snapshot ?? 'beta:guest:v1:fixture', overrides.amount ?? 1,
  );
  return { sqlite, sql, environment, calls, turnstileCalls, request, call, bootstrap, challenge, sendRaw, send, seed,
    setProvider(fn) { provider = fn; },
    setTurnstile(fn) { turnstile = fn; },
    close() { globalThis.fetch = originalFetch; sqlite.close(); },
  };
}

test('bootstrap issues a signed private cookie and returns configured capabilities without any secret or stored content', async () => {
  const f = fixture();
  try {
    const { response, data, cookie } = await f.bootstrap({ origin: null });
    assert.equal(response.status, 200); assert.equal(data.available, true); assert.equal(data.remaining, 5);
    assert.equal(data.model.id, 'gpt-6.1-sol'); assert.equal(data.maxPromptBytes, 4000);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('set-cookie'), /^__Host-prism-guest=.*; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/);
    assert.equal((await f.bootstrap({ cookie })).response.headers.get('set-cookie'), null);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
    assert.equal(f.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(data), /guest-test-only-key|203\.0\.113|beta:guest|guest:/);
    assert.equal(await f.call('conversations'), null);
    assert.equal((await f.call('guest/unknown')).status, 404);
  } finally { f.close(); }
});

test('missing credentials, disabled guest service, or unavailable database fail closed without inference', async () => {
  const f = fixture();
  try {
    delete f.environment.OPENAI_API_KEY;
    assert.equal((await f.bootstrap()).response.status, 503);
    f.environment.OPENAI_API_KEY = 'guest-test-only-key'; f.environment.GUEST_CHAT_ENABLED = 'false';
    assert.equal((await f.bootstrap()).data.available, false);
    delete f.environment.GUEST_CHAT_ENABLED;
    const response = await handleGuest(f.request('guest/bootstrap'), ['guest', 'bootstrap'], undefined, f.environment);
    assert.equal(response.status, 503);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('independent signing secrets preserve cookies and network quotas across provider-key rotation', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.bootstrap();
    await events(await f.send(cookie));
    const original = f.sqlite.prepare('SELECT user_id,rate_snapshot FROM usage').get();
    f.environment.OPENAI_API_KEY = 'rotated-openai-test-only-key';
    const reload = await f.bootstrap({ cookie });
    assert.equal(reload.response.headers.get('set-cookie'), null);
    assert.equal(reload.data.remaining, 4);
    assert.equal((await events(await f.send(cookie))).at(-1).type, 'done');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage WHERE user_id=? AND rate_snapshot=?').get(original.user_id, original.rate_snapshot).n, 2);
    assert.equal(f.calls.length, 2);
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

test('provider invocation uses the fixed model and real stream with bounded low reasoning, no tools, and no content persistence', async () => {
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
    assert.equal(body.model, 'gpt-6.1-sol'); assert.equal(body.store, false);
    assert.deepEqual(body.reasoning, { effort: 'low' }); assert.equal(body.max_output_tokens, 1024);
    assert.equal(body.tools, undefined); assert.deepEqual(body.input, [...history, { role: 'user', content: 'My private second prompt.' }]);
    const row = f.sqlite.prepare('SELECT * FROM usage').get();
    assert.equal(row.status, 'complete'); assert.equal(row.input_tokens, 12); assert.equal(row.output_tokens, 8); assert.equal(row.reserved_amount, 104);
    assert.match(row.user_id, /^guest:[a-f0-9]{64}$/); assert.match(row.rate_snapshot, /^beta:guest:v1:[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(row), /private|203\.0\.113|guest-test-only-key|real provider/);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM conversations').get().n, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM files').get().n, 0);
  } finally { f.close(); }
});


test('idempotency survives network retries and does not permit a second provider call, even with case-varied UUIDs', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.bootstrap();
    const requestId = crypto.randomUUID();
    await events(await f.send(cookie, { requestId }));
    const duplicate = await f.send(cookie, { requestId: requestId.toUpperCase(), prompt: 'Changed prompt on the same ID.' });
    assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, 'DUPLICATE_REQUEST');
    assert.equal(f.calls.length, 1);
    // A different signed session owns its own ID namespace; one user cannot
    // occupy another user's idempotency key.
    const other = await f.bootstrap();
    await events(await f.send(other.cookie, { requestId }));
    assert.equal(f.calls.length, 2);
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
      // Historical reservations still consume the same caps.
      if (mode === 'daily-budget') f.seed({ model: 'gpt-6.1-sol', provider: 'openai', amount: GUEST_POLICY.siteDailyBudgetMicros });
      if (mode === 'daily-count') for (let i = 0; i < GUEST_POLICY.siteDailyRequests; i++) f.seed({ model: 'gpt-6.1-sol', provider: 'openai', owner: 'guest:count-' + i });
      if (mode === 'beta-lifetime') f.seed({ owner: 'signed-in-user', snapshot: 'beta:v1', amount: GUEST_POLICY.betaLifetimeBudgetMicros, createdAt: Date.now() - 86_400_000 });
      const response = await f.send(cookie);
      assert.equal(response.status, mode === 'daily-count' ? 429 : 503, mode);
      const bootstrap = await f.bootstrap({ cookie });
      assert.equal(bootstrap.data.remaining, 0, mode);
      if (mode !== 'daily-count') {
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
    const row = f.sqlite.prepare('SELECT * FROM usage').get();
    assert.equal(row.status, 'error'); assert.ok(row.reserved_amount > 0);
  } finally { f.close(); }
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
    f.setProvider(async () => new Response('data: {"type":"response.output_text.delta","delta":"Partial answer"}\n\n'));
    const partial = await events(await f.send(cookie));
    assert.deepEqual(partial.map(event => event.type), ['start', 'delta', 'error']);
    assert.equal(partial.at(-1).code, 'GUEST_PROVIDER_ERROR');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM usage WHERE status='complete'").get().n, 0);
  } finally { f.close(); }
});

test('a dedicated valid signing secret is mandatory and provider credentials never serve as fallback', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.bootstrap();
    for (const value of [undefined, '', 'short', 'x'.repeat(257), 'x'.repeat(32) + '\n', 'x'.repeat(32) + '\0']) {
      f.environment.GUEST_SESSION_SIGNING_SECRET = value;
      const before = f.sqlite.prepare('SELECT COUNT(*) n FROM rate_limits').get().n;
      assert.equal((await f.bootstrap()).response.status, 503);
      assert.equal((await f.sendRaw(cookie)).status, 503);
      assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM rate_limits').get().n, before);
    }
    f.environment.OPENAI_API_KEY = 'same-provider-secret'.repeat(3);
    f.environment.GUEST_SESSION_SIGNING_SECRET = f.environment.OPENAI_API_KEY;
    assert.equal((await f.bootstrap()).response.status, 503, 'provider and signing secrets must differ');
    assert.equal(f.calls.length, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
  } finally { f.close(); }
});

test('duplicate, oversized, malformed, and cross-origin guest cookies cannot authorize a challenge or inference', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.bootstrap();
    for (const invalid of [cookie + '; ' + cookie, 'padding=' + 'x'.repeat(16385), '__Host-prism-guest=invalid',
      cookie.replace('=v1.', '=v2.'), cookie.replace(/\.\d{13}\./, '.9999999999999.')]) {
      assert.equal((await f.sendRaw(invalid)).status, 401);
      assert.equal((await f.challenge(invalid)).response.status, 401);
    }
    // Signatures include the origin. A cookie copied to an alternate hostname
    // is insufficient even when an attacker reproduces Origin/Fetch Metadata.
    const request = new Request('https://alternate.test/api/guest/chat', {
      method: 'POST', headers: { origin: 'https://alternate.test', cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), prompt: 'Not authorized' }),
    });
    assert.equal((await handleGuest(request, ['guest', 'chat'], f.sql, f.environment)).status, 401);
    assert.equal((await f.challenge(undefined)).response.status, 401);
    assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
  } finally { f.close(); }
});

test('proof challenges bind the cookie session and network bucket and reject tampering before reservations', async () => {
  const f = fixture();
  try {
    const first = await f.bootstrap(), second = await f.bootstrap();
    const proof = solveProof(first.data.challenge);
    assert.equal((await f.sendRaw(first.cookie)).status, 403);
    assert.equal((await f.sendRaw(second.cookie, { proof })).status, 403);
    assert.equal((await f.sendRaw(first.cookie, { proof }, { ip: '203.0.113.21' })).status, 403);
    const changedSignature = { ...proof, token: proof.token.slice(0, -1) + (proof.token.endsWith('a') ? 'b' : 'a') };
    assert.equal((await f.sendRaw(first.cookie, { proof: changedSignature })).status, 403);
    const invalidSolution = { ...proof, solution: (parseInt(proof.solution, 16) + 1).toString(16) };
    while (createHash('sha256').update(invalidSolution.token + ':' + invalidSolution.solution).digest().readUInt16BE(0) < 2)
      invalidSolution.solution = (parseInt(invalidSolution.solution, 16) + 1).toString(16);
    assert.equal((await f.sendRaw(first.cookie, { proof: invalidSolution })).status, 403);
    for (const value of [null, [], {}, { token: proof.token, solution: proof.solution, owner: 'another' },
      { token: 'x'.repeat(181), solution: '0' }, { token: proof.token, solution: 'f'.repeat(9) }])
      assert.equal((await f.sendRaw(first.cookie, { proof: value })).status, 400);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM rate_limits WHERE key LIKE 'guest-proof:%'").get().n, 0);
    assert.equal(f.calls.length, 0);
    // A different host/network/session never consumes the real owner's proof.
    assert.equal((await events(await f.sendRaw(first.cookie, { proof }))).at(-1).type, 'done');
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test('expired and excessive-future challenges fail even with valid signatures', async t => {
  const f = fixture(); let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  try {
    const { cookie, data } = await f.bootstrap(), proof = solveProof(data.challenge);
    clock += 120001;
    assert.equal((await f.sendRaw(cookie, { proof })).status, 403);
    // Construct a correctly signed proof using only the fixture secret to test
    // expiry independently of signature rejection.
    const hmac = (scope, value) => createHmac('sha256', f.environment.GUEST_SESSION_SIGNING_SECRET).update('openprism:guest:v1:' + scope + ':' + value).digest('hex');
    const session = cookie.split('=')[1].split('.')[1];
    const owner = 'guest:' + hmac('session', session), snapshot = 'beta:guest:v1:' + hmac('network', '203.0.113.20');
    const expires = clock + 120001, payload = `v1.${expires}.15.${'b'.repeat(32)}`;
    const future = { kind: 'proof-of-work', difficulty: 15, token: payload + '.' + hmac('proof', `${owner}:${snapshot}:${payload}`), expiresAt: new Date(expires).toISOString() };
    const denied = await f.sendRaw(cookie, { proof: solveProof(future) });
    assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'GUEST_CHALLENGE_EXPIRED');
    assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
  } finally { f.close(); }
});

test('one-time proof redemption is atomic across concurrent different request IDs and later replays', async () => {
  const f = fixture(); let release;
  try {
    const { cookie, data } = await f.bootstrap(), proof = solveProof(data.challenge);
    f.setProvider(() => new Promise(resolve => { release = () => resolve(successStream()); }));
    const results = await Promise.all([f.sendRaw(cookie, { proof }), f.sendRaw(cookie, { proof })]);
    assert.deepEqual(results.map(response => response.status).sort(), [200, 403]);
    assert.equal((await results.find(response => response.status === 403).json()).code, 'GUEST_CHALLENGE_REPLAYED');
    assert.equal(f.calls.length, 1); assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 1);
    release(); await events(results.find(response => response.status === 200));
    const replay = await f.sendRaw(cookie, { proof });
    assert.equal(replay.status, 403); assert.equal((await replay.json()).code, 'GUEST_CHALLENGE_REPLAYED');
    assert.equal(f.calls.length, 1);
  } finally { release?.(); f.close(); }
});

test('higher network activity receives the stronger signed challenge without trusting requested difficulty', async () => {
  const f = fixture();
  try {
    const { cookie, data } = await f.bootstrap(); assert.equal(data.challenge.difficulty, 15);
    await events(await f.sendRaw(cookie, { proof: solveProof(data.challenge) }));
    const { rate_snapshot: snapshot } = f.sqlite.prepare('SELECT rate_snapshot FROM usage').get();
    for (let n = 1; n < 8; n++) f.seed({ owner: 'guest:other-' + n, snapshot });
    const next = await f.challenge(cookie); assert.equal(next.challenge.difficulty, 17);
    const proof = solveProof(next.challenge);
    const lowered = { ...proof, token: proof.token.replace('.17.', '.15.') };
    assert.equal((await f.sendRaw(cookie, { proof: lowered })).status, 403);
    assert.equal((await events(await f.sendRaw(cookie, { proof }))).at(-1).type, 'done');
    assert.equal(f.calls.length, 2);
  } finally { f.close(); }
});

test('bootstrap and challenge issuance share atomic per-network caps that cookie deletion cannot reset', async t => {
  const f = fixture(); let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  try {
    const first = await f.bootstrap();
    const responses = await Promise.all(Array.from({ length: 70 }, (_, index) => index % 2
      ? f.call('guest/challenge', 'GET', undefined, { cookie: first.cookie })
      : f.call('guest/bootstrap')));
    assert.equal(responses.filter(response => response.status === 200).length, 59);
    assert.equal(responses.filter(response => response.status === 429).length, 11);
    const denied = await f.bootstrap(); assert.equal(denied.response.status, 429);
    assert.equal(denied.response.headers.get('retry-after'), '60'); assert.equal(denied.response.headers.get('set-cookie'), null);
    assert.equal((await f.bootstrap({ ip: '203.0.113.40' })).response.status, 200);
    assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
    clock += 60001;
    assert.equal((await f.bootstrap({ cookie: first.cookie })).response.status, 200);
    assert.equal(f.sqlite.prepare("SELECT count FROM rate_limits WHERE key LIKE 'guest-network:%'").get().count, 1);
  } finally { f.close(); }
});

test('the global issuance cap bounds new network rows even after many distributed identities are blocked', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    f.sqlite.prepare('INSERT INTO rate_limits (key,count,expires_at) VALUES (?,599,?)').run('guest-global', now + 60000);
    const responses = await Promise.all(Array.from({ length: 30 }, (_, n) => f.call('guest/bootstrap', 'GET', undefined, { ip: '198.51.100.' + n })));
    assert.equal(responses.filter(response => response.status === 200).length, 1);
    assert.equal(responses.filter(response => response.status === 429).length, 29);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM rate_limits WHERE key LIKE 'guest-network:%'").get().n, 1);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('guest and authenticated budget pools are isolated while the original total cap includes historical spending', async () => {
  assert.equal(BETA_ACCOUNT_BUDGET_MICROS + BETA_GUEST_BUDGET_MICROS, BETA_TOTAL_BUDGET_MICROS);
  for (const mode of ['guest-exhausted', 'account-exhausted', 'historical-total']) {
    const f = fixture();
    try {
      const { cookie } = await f.bootstrap();
      if (mode === 'guest-exhausted') {
        f.seed({ snapshot: 'beta:guest:v1:legacy', amount: BETA_GUEST_BUDGET_MICROS, createdAt: Date.now() - 86400000, model: 'gpt-6.1-sol', provider: 'openai' });
        assert.equal((await f.sendRaw(cookie)).status, 503);
        assert.ok(await reserveBeta(f.sql, 'new-signed-account', crypto.randomUUID(), 100, Date.now()) > 0);
        assert.ok(await reserveMedia(f.sql, 'new-media-account', crypto.randomUUID(), 'test-image', 'openai', 10000, Date.now()) > 0);
        assert.equal(f.calls.length, 0);
      } else if (mode === 'account-exhausted') {
        f.seed({ owner: 'signed-legacy', snapshot: 'beta:v1', amount: BETA_ACCOUNT_BUDGET_MICROS, createdAt: Date.now() - 86400000 });
        await assert.rejects(() => reserveBeta(f.sql, 'new-signed-account', crypto.randomUUID(), 100, Date.now()), error => error.status === 429);
        await assert.rejects(() => reserveMedia(f.sql, 'new-media-account', crypto.randomUUID(), 'test-image', 'openai', 10000, Date.now()), error => error.status === 429);
        assert.equal((await events(await f.send(cookie))).at(-1).type, 'done');
        assert.equal(f.calls.length, 1);
      } else {
        // A pre-patch guest overspend above its new pool still counts against
        // the original total; adding pools cannot grant a second allowance.
        f.seed({ snapshot: 'beta:guest:v1:historical', amount: BETA_TOTAL_BUDGET_MICROS - 1, createdAt: Date.now() - 86400000 });
        assert.equal((await f.sendRaw(cookie)).status, 503);
        await assert.rejects(() => reserveBeta(f.sql, 'new-signed-account', crypto.randomUUID(), 100, Date.now()), error => error.status === 429);
        await assert.rejects(() => reserveMedia(f.sql, 'new-media-account', crypto.randomUUID(), 'test-image', 'openai', 10000, Date.now()), error => error.status === 429);
        assert.equal(f.calls.length, 0);
      }
    } finally { f.close(); }
  }
});

test('distributed guest sessions cannot race the final authorized reservation into multiple provider calls', async () => {
  const f = fixture(); let release;
  try {
    const reservation = (4097 * 2 + GUEST_POLICY.maxOutputTokens * 10);
    f.seed({ owner: 'guest:historical-cost', amount: GUEST_POLICY.guestLifetimeBudgetMicros - reservation, createdAt: Date.now() - 86400000 });
    const clients = [];
    for (let n = 0; n < 12; n++) {
      const ip = '198.51.100.' + (n + 50), { cookie, data } = await f.bootstrap({ ip });
      assert.equal(data.available, true);
      clients.push({ ip, cookie, proof: solveProof(data.challenge) });
    }
    f.setProvider(() => new Promise(resolve => { release = () => resolve(successStream()); }));
    const responses = await Promise.all(clients.map(client => f.sendRaw(client.cookie, { prompt: 'X', proof: client.proof }, { ip: client.ip })));
    assert.equal(responses.filter(response => response.status === 200).length, 1);
    assert.equal(responses.filter(response => response.status === 503).length, 11);
    assert.equal(f.calls.length, 1);
    assert.equal(f.sqlite.prepare('SELECT SUM(reserved_amount) amount FROM usage').get().amount, GUEST_POLICY.guestLifetimeBudgetMicros);
    for (const response of responses.filter(response => response.status !== 200)) assert.equal((await response.json()).code, 'GUEST_SITE_LIMIT');
    release(); await events(responses.find(response => response.status === 200));
  } finally { release?.(); f.close(); }
});

function enableTurnstile(f) {
  Object.assign(f.environment, { GUEST_BOT_PROTECTION: 'turnstile', APP_ORIGIN: 'https://prism.test',
    TURNSTILE_SITE_KEY: 'fixture-turnstile-sitekey', TURNSTILE_SECRET_KEY: 'fixture-turnstile-secretkey' });
}

test('Turnstile requires complete production configuration and never falls back from an invalid mode', async () => {
  for (const override of [{ GUEST_BOT_PROTECTION: 'disabled' }, { TURNSTILE_SITE_KEY: undefined }, { TURNSTILE_SECRET_KEY: undefined },
    { APP_ORIGIN: 'http://prism.test' }, { APP_ORIGIN: 'https://prism.test/path' }, { APP_ORIGIN: 'https://user:secret@prism.test' },
    { TURNSTILE_SITE_KEY: '1x00000000000000000000AA' }, { TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }]) {
    const f = fixture();
    try {
      enableTurnstile(f); Object.assign(f.environment, override);
      assert.equal((await f.bootstrap()).response.status, 503);
      assert.equal(f.calls.length, 0); assert.equal(f.turnstileCalls.length, 0);
    } finally { f.close(); }
  }
});

test('Turnstile verifies hostname and action before usage and blocks replay even if upstream accepts a token twice', async () => {
  const f = fixture();
  try {
    enableTurnstile(f);
    const { cookie, data } = await f.bootstrap();
    assert.deepEqual(data.challenge, { kind: 'turnstile', siteKey: 'fixture-turnstile-sitekey', action: 'guest_chat' });
    assert.doesNotMatch(JSON.stringify(data), /fixture-turnstile-secretkey/);
    f.setTurnstile(async () => {
      assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
      return Response.json({ success: true, hostname: 'prism.test', action: 'guest_chat' });
    });
    const token = 'valid-single-use-token';
    assert.equal((await events(await f.sendRaw(cookie, { turnstileToken: token }))).at(-1).type, 'done');
    f.setTurnstile(async () => Response.json({ success: true, hostname: 'prism.test', action: 'guest_chat' }));
    const other = await f.bootstrap({ ip: '203.0.113.51' });
    const replay = await f.sendRaw(other.cookie, { turnstileToken: token }, { ip: '203.0.113.51' });
    assert.equal(replay.status, 403); assert.equal((await replay.json()).code, 'GUEST_CHALLENGE_REPLAYED');
    assert.equal(f.calls.length, 1); assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 1);
    assert.equal(f.turnstileCalls.length, 2);
    assert.ok(f.turnstileCalls.every(call => /^[a-f\d-]{36}$/.test(call.body.idempotency_key)));
  } finally { f.close(); }
});

test('Turnstile errors, wrong claims, malformed responses, redirects and oversized tokens never invoke AI or reserve usage', async () => {
  const cases = [
    [() => Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] }), 403],
    [() => Response.json({ success: true, hostname: 'attacker.test', action: 'guest_chat' }), 403],
    [() => Response.json({ success: true, hostname: 'prism.test', action: 'other_action' }), 403],
    [() => Response.json({ success: 'true', hostname: 'prism.test', action: 'guest_chat' }), 403],
    [() => Response.json(null), 403], [() => new Response('{malformed'), 503],
    [() => new Response('unavailable', { status: 503 }), 503],
    [() => new Response(null, { status: 302, headers: { location: 'https://attacker.test/' } }), 503],
    [() => { throw new Error('fixture secret must not appear'); }, 503],
  ];
  for (const [upstream, status] of cases) {
    const f = fixture();
    try {
      enableTurnstile(f); f.setTurnstile(upstream);
      const { cookie } = await f.bootstrap();
      const response = await f.sendRaw(cookie, { turnstileToken: 'test-untrusted-token' });
      assert.equal(response.status, status); assert.doesNotMatch(await response.text(), /fixture secret|attacker\.test|fixture-turnstile-secretkey/);
      assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
      assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM rate_limits WHERE key LIKE 'guest-proof:%'").get().n, 0);
      assert.equal((await f.sendRaw(cookie, { turnstileToken: 'x'.repeat(2049) })).status, 400);
      assert.equal((await f.sendRaw(cookie)).status, 403);
      assert.equal(f.turnstileCalls.length, 1);
    } finally { f.close(); }
  }
});

test('Turnstile completion uses the current day and cancellation never reserves a provider request', async t => {
  const f = fixture(); let clock = Date.parse('2026-11-10T23:59:59.000Z'); t.mock.method(Date, 'now', () => clock);
  try {
    enableTurnstile(f); const { cookie } = await f.bootstrap();
    f.setTurnstile(async () => { clock += 2000; return Response.json({ success: true, hostname: 'prism.test', action: 'guest_chat' }); });
    assert.equal((await events(await f.sendRaw(cookie, { turnstileToken: 'midnight-proof' }))).at(-1).type, 'done');
    assert.equal(f.sqlite.prepare('SELECT created_at FROM usage').get().created_at, Date.parse('2026-11-11T00:00:01.000Z'));
    const aborter = new AbortController();
    f.setTurnstile(async () => { aborter.abort(); return Response.json({ success: true, hostname: 'prism.test', action: 'guest_chat' }); });
    const cancelled = await f.sendRaw(cookie, { turnstileToken: 'cancelled-proof' }, { signal: aborter.signal });
    assert.equal(cancelled.status, 408); assert.equal(f.calls.length, 1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 1);
  } finally { f.close(); }
});
