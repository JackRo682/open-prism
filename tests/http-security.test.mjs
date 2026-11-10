import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const runtime = new URL('../.sites-runtime/http-security-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
await writeFile(new URL('http-security.mjs', runtime), ts.transpileModule(
  await readFile(new URL('../lib/http-security.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText);
const { SCRIPT_NONCE_HEADER, pageContentSecurityPolicy, prepareSecureRequest, rejectUnsupportedPageMutation, secureResponse } = await import(new URL('http-security.mjs', runtime));
const req = (path = '/', options) => new Request('https://prism.test' + path, options);
const html = () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600', 'ETag': 'private-data', 'X-Powered-By': 'server' } });

test('every page receives a fresh nonce and cannot choose its own script policy', async () => {
  const input = req('/', { headers: { [SCRIPT_NONCE_HEADER]: 'attacker', 'Content-Security-Policy': "script-src * 'unsafe-inline'", 'Content-Security-Policy-Report-Only': "script-src *", 'oai-authenticated-user-id': 'test-user' } });
  const first = prepareSecureRequest(input), second = prepareSecureRequest(input);
  const nonce = first.request.headers.get(SCRIPT_NONCE_HEADER);
  assert.match(nonce, /^[A-Za-z0-9+/]{32}$/);
  assert.notEqual(nonce, second.request.headers.get(SCRIPT_NONCE_HEADER));
  assert.ok(first.policy.includes("'nonce-" + nonce + "'"));
  assert.equal(first.request.headers.get('Content-Security-Policy'), first.policy);
  assert.equal(first.request.headers.get('Content-Security-Policy-Report-Only'), null);
  assert.equal(first.request.headers.get('oai-authenticated-user-id'), 'test-user');
  const scriptPolicy = first.policy.split('; ').find(part => part.startsWith('script-src '));
  assert.doesNotMatch(scriptPolicy, /unsafe-inline|unsafe-eval|data:|blob:/);
  assert.match(first.policy, /script-src-attr 'none'/);
  assert.match(first.policy, /object-src 'none'; base-uri 'none'/);
  assert.throws(() => pageContentSecurityPolicy('"><script>bad</script>'));
});

test('request preparation preserves streaming body and cancellation', async () => {
  const aborter = new AbortController();
  const prepared = prepareSecureRequest(req('/api/chat', { method: 'POST', body: '{"prompt":"hello"}', signal: aborter.signal }));
  assert.equal(await prepared.request.text(), '{"prompt":"hello"}');
  aborter.abort();
  assert.equal(prepared.request.signal.aborted, true);
});

test('HTML and private component responses are never stored in browser or shared caches', async () => {
  for (const type of ['text/html; charset=utf-8', 'text/x-component']) {
    const input = html(); input.headers.set('Content-Type', type);
    const response = secureResponse(req('/chat/123'), input, prepareSecureRequest(req()).policy);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store');
    assert.equal(response.headers.get('ETag'), null);
    assert.equal(response.headers.get('X-Powered-By'), null);
    assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
    assert.match(response.headers.get('X-Robots-Tag'), /noindex.*nosnippet/);
    assert.equal(await response.text(), '<html></html>');
  }
});

test('page policies stop arbitrary framing while retaining the Sites and OAuth integration', () => {
  const secure = prepareSecureRequest(req());
  const response = secureResponse(req('/share/' + 'a'.repeat(64)), html(), secure.policy);
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'self' https:\/\/chatgpt\.com(?:;|$)/);
  assert.equal(response.headers.get('X-Frame-Options'), null);
  assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin-allow-popups');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000');
  assert.match(response.headers.get('Permissions-Policy'), /microphone=\(self\)/);
  assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
});

test('SSE stays incremental and private, and hardened responses preserve cookies and ranges', async () => {
  let producer;
  const source = new ReadableStream({ start(controller) { producer = controller; } });
  const response = secureResponse(req('/api/chat'), new Response(source, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Set-Cookie': '__Host-test=abc; Secure; HttpOnly; Path=/' } }), 'unused');
  const reader = response.body.getReader();
  const first = reader.read(); producer.enqueue(new TextEncoder().encode('data: first\n\n'));
  assert.equal(new TextDecoder().decode((await first).value), 'data: first\n\n');
  producer.close(); assert.equal((await reader.read()).done, true);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store, no-transform');
  assert.match(response.headers.get('Set-Cookie'), /Secure; HttpOnly/);
  assert.match(response.headers.get('Content-Security-Policy'), /sandbox/);
  const range = secureResponse(req('/api/media/id/content'), new Response('abc', { status: 206, headers: { 'Content-Range': 'bytes 0-2/10', 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' } }), 'unused');
  assert.equal(range.status, 206); assert.equal(range.headers.get('Content-Range'), 'bytes 0-2/10');
  assert.equal(await range.text(), 'abc');
});

test('public static assets keep their cache policy and local HTTP does not enable HSTS', () => {
  const response = secureResponse(new Request('http://localhost/assets/app.js'), new Response('/* script */', { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=31536000, immutable', ETag: 'static' } }), 'unused');
  assert.match(response.headers.get('Cache-Control'), /immutable/);
  assert.equal(response.headers.get('ETag'), 'static');
  assert.equal(response.headers.get('Strict-Transport-Security'), null);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('authentication redirects without a content type are not cached', () => {
  const response = secureResponse(req('/chat'), Response.redirect('https://prism.test/signin-with-chatgpt?return_to=%2Fchat', 307), 'unused');
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('Location'), 'https://prism.test/signin-with-chatgpt?return_to=%2Fchat');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
});

test('unsolicited Server Action posts are rejected before framework deserialization', () => {
  const rejected = rejectUnsupportedPageMutation(req('/chat', { method: 'POST', headers: { 'Next-Action': 'attacker-controlled' }, body: 'untrusted flight payload' }));
  assert.equal(rejected.status, 405); assert.equal(rejected.headers.get('Allow'), 'GET, HEAD, OPTIONS');
  assert.equal(rejectUnsupportedPageMutation(req('/api/chat', { method: 'POST' })), null);
  assert.equal(rejectUnsupportedPageMutation(req('/api/payments/webhook', { method: 'POST' })), null);
  assert.equal(rejectUnsupportedPageMutation(req('/upgrade/success')), null);
});
