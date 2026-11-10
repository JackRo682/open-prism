import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const runtime = new URL('../.sites-runtime/guest-proof-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
const source = await readFile(new URL('../lib/guest-proof.ts', import.meta.url), 'utf8');
await writeFile(new URL('guest-proof.mjs', runtime), ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const { solveGuestChallenge, loadGuestChallenge } = await import(new URL('guest-proof.mjs', runtime));

test('a rotated guest cookie refreshes once before obtaining work, without retrying inference', async () => {
  const calls = [], signal = new AbortController().signal;
  const fetcher = async (url, options) => {
    calls.push(url); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.signal, signal);
    if (calls.length === 1) return Response.json({code: 'GUEST_SESSION_REQUIRED'}, {status: 401});
    if (url === '/api/guest/bootstrap') return Response.json({available: true});
    return Response.json({available: true, challenge: proofChallenge()});
  };
  const result = await loadGuestChallenge(signal, fetcher);
  assert.equal(result.response.status, 200); assert.equal(result.value.challenge.kind, 'proof-of-work');
  assert.deepEqual(calls, ['/api/guest/challenge', '/api/guest/bootstrap', '/api/guest/challenge']);
});

test('guest challenge recovery is bounded and preserves configuration failures', async () => {
  for (const bootstrapFails of [false, true]) {
    let calls = 0;
    const result = await loadGuestChallenge(new AbortController().signal, async url => {
      calls++;
      if (url === '/api/guest/bootstrap') return Response.json({available: !bootstrapFails, code: 'GUEST_UNAVAILABLE'}, {status: bootstrapFails ? 503 : 200});
      return Response.json({code: 'GUEST_SESSION_REQUIRED'}, {status: 401});
    });
    assert.equal(calls, bootstrapFails ? 2 : 3);
    assert.equal(result.response.status, bootstrapFails ? 503 : 401);
  }
});

test('cancelled challenge loading makes no network request', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(() => loadGuestChallenge(controller.signal, async () => {calls++;return Response.json({});}), {name: 'AbortError'});
  assert.equal(calls, 0);
});

const proofChallenge = (difficulty = 15, expires = Date.now() + 120000) => ({
  kind: 'proof-of-work', difficulty, expiresAt: new Date(expires).toISOString(),
  token: `v1.${expires}.${difficulty}.${'1'.repeat(32)}.${'a'.repeat(64)}`,
});

test('the browser proof solver produces independently verified SHA-256 work for both supported difficulties', async t => {
  // Stable challenge bytes make CI work deterministic rather than allowing a
  // randomly unlucky high nonce to dominate the test's runtime.
  t.mock.method(Date, 'now', () => Date.parse('2026-11-10T12:00:00Z'));
  for (const difficulty of [15, 17]) {
    const challenge = proofChallenge(difficulty);
    const result = await solveGuestChallenge(challenge, new AbortController().signal);
    assert.equal(result.proof.token, challenge.token);
    assert.match(result.proof.solution, /^[a-f\d]{1,8}$/);
    const hash = createHash('sha256').update(result.proof.token + ':' + result.proof.solution).digest();
    for (let bit = 0; bit < difficulty; bit++) assert.equal((hash[Math.floor(bit / 8)] >> (7 - bit % 8)) & 1, 0);
  }
});

test('unsupported, malformed, and expired challenges fail without unbounded work', async () => {
  const valid = proofChallenge();
  for (const challenge of [{ ...valid, difficulty: 20 }, { ...valid, kind: 'unknown' },
    { ...valid, token: 'forged' }, { ...valid, expiresAt: 'never' }, proofChallenge(15, Date.now() - 1),
    { kind: 'turnstile', siteKey: 'fixture-sitekey', action: 'different_action' },
    { kind: 'turnstile', siteKey: 'bad', action: 'guest_chat' }]) {
    await assert.rejects(() => solveGuestChallenge(challenge, new AbortController().signal));
  }
});

test('cancellation stops proof computation before a new batch and never returns a sendable proof', async t => {
  const before = new AbortController(); before.abort();
  await assert.rejects(() => solveGuestChallenge(proofChallenge(), before.signal), { name: 'AbortError' });
  const during = new AbortController(); let hashes = 0;
  t.mock.method(crypto.subtle, 'digest', async () => {
    hashes++;
    if (hashes === 128) during.abort();
    return new Uint8Array(32).fill(255).buffer;
  });
  await assert.rejects(() => solveGuestChallenge(proofChallenge(), during.signal), { name: 'AbortError' });
  assert.equal(hashes, 128);
});

function widgetFixture(t, render) {
  const previousWindow = globalThis.window;
  const removed = [], container = { cleared: 0, replaceChildren() { this.cleared++; } };
  globalThis.window = { turnstile: { render, remove(id) { removed.push(id); } } };
  t.after(() => previousWindow === undefined ? delete globalThis.window : globalThis.window = previousWindow);
  return { container, removed, challenge: { kind: 'turnstile', siteKey: 'fixture-public-sitekey', action: 'guest_chat' } };
}

test('Turnstile uses only its public site key, returns the actual token, and removes the widget after success', async t => {
  let rendered;
  const f = widgetFixture(t, (container, options) => {
    rendered = { container, options };
    queueMicrotask(() => options.callback('provider-issued-token'));
    return 'widget-success';
  });
  const result = await solveGuestChallenge(f.challenge, new AbortController().signal, f.container);
  assert.deepEqual(result, { turnstileToken: 'provider-issued-token' });
  assert.equal(rendered.container, f.container);
  assert.equal(rendered.options.sitekey, 'fixture-public-sitekey');
  assert.equal(rendered.options.action, 'guest_chat');
  assert.equal(rendered.options.secret, undefined);
  assert.deepEqual(f.removed, ['widget-success']); assert.equal(f.container.cleared, 1);
});

test('Turnstile errors and expiry clear the widget without synthesizing a successful token', async t => {
  for (const callback of ['error-callback', 'expired-callback']) {
    const f = widgetFixture(t, (_container, options) => {
      queueMicrotask(() => options[callback]());
      return 'widget-' + callback;
    });
    await assert.rejects(() => solveGuestChallenge(f.challenge, new AbortController().signal, f.container));
    assert.deepEqual(f.removed, ['widget-' + callback]); assert.equal(f.container.cleared, 1);
  }
});

test('cancelling Turnstile removes the widget once and ignores a late provider callback', async t => {
  let options;
  const f = widgetFixture(t, (_container, supplied) => { options = supplied; return 'widget-cancelled'; });
  const aborter = new AbortController();
  const pending = solveGuestChallenge(f.challenge, aborter.signal, f.container);
  await new Promise(resolve => setImmediate(resolve));
  aborter.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  options.callback('late-token');
  assert.deepEqual(f.removed, ['widget-cancelled']); assert.equal(f.container.cleared, 1);
});
