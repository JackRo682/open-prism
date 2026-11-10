import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const runtime = new URL('../.sites-runtime/platform-identity-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
const source = await readFile(new URL('../lib/platform-identity.ts', import.meta.url), 'utf8');
await writeFile(new URL('platform-identity.mjs', runtime), ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const { readPlatformIdentity, platformRequestMatchesOrigin, sanitizePlatformIdentity } = await import(new URL('platform-identity.mjs', runtime));
const environment = { APP_ORIGIN: 'https://getopenprism.com' };
const origin = environment.APP_ORIGIN;
function headers(extra = {}) {
  return new Headers({ host: 'getopenprism.com', 'oai-authenticated-user-id': 'site-owner_123', 'oai-authenticated-user-email': 'person@example.com', ...extra });
}

test('canonical platform assertions preserve stable owner IDs and decode optional display names', () => {
  const asserted = headers({ 'oai-authenticated-user-full-name': encodeURIComponent('노휘석, Test'), 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8' });
  assert.deepEqual(readPlatformIdentity(asserted, environment, origin + '/chat/123'), {
    userId: 'site-owner_123', email: 'person@example.com', fullName: '노휘석, Test', displayName: '노휘석, Test',
  });
  for (const host of ['getopenprism.com', 'GETOPENPRISM.COM', 'getopenprism.com:443']) {
    assert.ok(readPlatformIdentity(headers({ host }), environment));
  }
  assert.ok(readPlatformIdentity(headers(), { APP_ORIGIN: origin + '/' }));
  assert.ok(readPlatformIdentity(headers(), { APP_ORIGIN: 'https://GETOPENPRISM.COM:443/' }));
  assert.equal(readPlatformIdentity(new Headers({ host: 'getopenprism.com' }), environment), null);
});

test('foreign and ambiguous entry hosts stay unauthenticated even with well-formed identity assertions', () => {
  for (const host of ['alternate.workers.dev', 'preview.chatgpt.pub', 'www.getopenprism.com', 'getopenprism.com.attacker.example',
    'getopenprism.com.', 'getopenprism.com:80', 'getopenprism.com:8443', 'getopenprism.com:0443',
    'getopenprism.com, getopenprism.com', 'getopenprism.com@attacker.example', 'getopenprism.com/path',
    'getopenprism.com?forwarded=true', 'getopenprism%2ecom', 'https://getopenprism.com', 'getopenprism.com\\attacker']) {
    assert.equal(readPlatformIdentity(headers({ host, 'x-forwarded-host': 'getopenprism.com', 'x-forwarded-proto': 'https' }), environment), null, host);
  }
  const missing = headers(); missing.delete('host');
  missing.set('x-forwarded-host', 'getopenprism.com');
  assert.equal(readPlatformIdentity(missing, environment), null);
  const repeated = headers(); repeated.append('host', 'getopenprism.com');
  assert.equal(readPlatformIdentity(repeated, environment), null);
});

test('absent or malformed canonical configuration never enables header authentication', () => {
  for (const APP_ORIGIN of [undefined, '', 'getopenprism.com', 'http://getopenprism.com', '//getopenprism.com',
    'https://getopenprism.com/path', 'https://getopenprism.com/path/..', 'https://getopenprism.com?query',
    'https://getopenprism.com#fragment', 'https://user:pass@getopenprism.com', 'https://@getopenprism.com', 'https://getopenprism%2ecom', ' https://getopenprism.com',
    'https://getopenprism.com\n', 'https://getopenprism.com.', 'https://getopenprism.com\\@attacker.example']) {
    assert.equal(readPlatformIdentity(headers(), { APP_ORIGIN }), null, String(APP_ORIGIN));
  }
});

test('worker ingress compares the actual URL as well as Host and does not accept spoofed forwarding metadata', () => {
  const asserted = headers({ 'x-forwarded-host': 'getopenprism.com', 'x-forwarded-proto': 'https', 'cf-ray': 'not-an-identity-proof' });
  assert.equal(platformRequestMatchesOrigin(new Request(origin + '/chat', { headers: asserted }), environment), true);
  for (const url of ['https://alternate.workers.dev/chat', 'https://preview.chatgpt.pub/chat', 'http://getopenprism.com/chat', 'https://getopenprism.com:8443/chat']) {
    const request = new Request(url, { headers: asserted });
    assert.equal(platformRequestMatchesOrigin(request, environment), false, url);
    assert.equal(readPlatformIdentity(request.headers, environment, request.url), null, url);
  }
  assert.equal(platformRequestMatchesOrigin(new Request(origin + '/chat', { headers: headers({ host: 'alternate.workers.dev' }) }), environment), false);
});

test('sanitizer strips every platform identity field on a foreign entry and preserves body, other headers and request settings', async () => {
  const controller = new AbortController();
  const body = JSON.stringify({ message: 'Preserve this request body exactly: 한글', count: 3 });
  const request = new Request('https://alternate.workers.dev/api/chat?mode=default', {
    method: 'POST', body, signal: controller.signal, redirect: 'manual', credentials: 'include', cache: 'no-store',
    headers: headers({
      'oai-authenticated-user-full-name': 'Test%20Person',
      'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
      'OAI-Authenticated-User-Future-Claim': 'must-also-be-removed',
      'content-type': 'application/json', 'x-request-id': 'fixture-request', cookie: '__Host-prism_session=fixture-cookie',
    }),
  });
  const sanitized = sanitizePlatformIdentity(request, environment);
  assert.notEqual(sanitized, request);
  assert.equal(sanitized.url, request.url);
  assert.equal(sanitized.method, 'POST');
  assert.equal(sanitized.redirect, 'manual');
  assert.equal(sanitized.credentials, 'include');
  assert.equal(sanitized.cache, 'no-store');
  assert.equal(sanitized.bodyUsed, false, 'the sanitizer must not read the request body');
  assert.ok([...sanitized.headers.keys()].every(name => !name.startsWith('oai-authenticated-user-')));
  for (const name of ['host', 'content-type', 'x-request-id', 'cookie']) assert.equal(sanitized.headers.get(name), request.headers.get(name), name);
  assert.equal(request.headers.get('oai-authenticated-user-id'), 'site-owner_123', 'original immutable headers are not modified');
  assert.equal(await sanitized.text(), body);
  assert.equal(sanitized.signal.aborted, false);
  controller.abort();
  assert.equal(sanitized.signal.aborted, true, 'the original cancellation signal still propagates');
});

test('sanitizer retains canonical requests unchanged and removes assertions when host or configuration is invalid', async () => {
  const canonical = new Request(origin + '/api/chat', { method: 'POST', body: 'canonical-body', headers: headers() });
  assert.equal(sanitizePlatformIdentity(canonical, environment), canonical);
  assert.equal(canonical.bodyUsed, false);
  assert.equal(await canonical.text(), 'canonical-body');
  for (const [host, env] of [['alternate.workers.dev', environment], ['getopenprism.com', {}], ['getopenprism.com', { APP_ORIGIN: 'http://getopenprism.com' }]]) {
    const request = new Request(origin + '/api/chat', { headers: headers({ host }) });
    const sanitized = sanitizePlatformIdentity(request, env);
    assert.ok([...sanitized.headers.keys()].every(name => !name.startsWith('oai-authenticated-user-')));
    assert.equal(readPlatformIdentity(sanitized.headers, environment, sanitized.url), null);
  }
  const anonymous = new Request('https://alternate.workers.dev/', { headers: { host: 'alternate.workers.dev', accept: 'text/html' } });
  assert.equal(sanitizePlatformIdentity(anonymous, environment), anonymous);
});

test('missing, duplicate, oversized or malformed required identity headers fail closed', () => {
  for (const name of ['oai-authenticated-user-id', 'oai-authenticated-user-email']) {
    const missing = headers(); missing.delete(name);
    assert.equal(readPlatformIdentity(missing, environment), null, name);
    const repeated = headers(); repeated.append(name, repeated.get(name));
    assert.equal(readPlatformIdentity(repeated, environment), null, name);
  }
  for (const userId of ['', 'a'.repeat(201), 'another user', 'admin,user', 'admin/user', 'user@elsewhere']) {
    assert.equal(readPlatformIdentity(headers({ 'oai-authenticated-user-id': userId }), environment), null, userId);
  }
  for (const email of ['', 'a'.repeat(321), 'not-an-email', 'one@@example.com', 'a b@example.com',
    'a@example..com', 'a@-example.com', 'a@example.com, b@example.com', 'a@', '.a@example.com', 'a.@example.com', 'a..b@example.com', '"quoted,local"@example.com']) {
    assert.equal(readPlatformIdentity(headers({ 'oai-authenticated-user-email': email }), environment), null, email);
  }
  // Headers rejects some controls at construction; a raw framework reader must
  // still fail safely if a nonstandard ingress supplies such values.
  const valid = headers();
  for (const [name, value] of [['host', 'getopenprism.com\r\n'], ['oai-authenticated-user-id', 'admin\u0000'],
    ['oai-authenticated-user-id', ' admin'], ['oai-authenticated-user-email', 'a@example.com\u007f']]) {
    assert.equal(readPlatformIdentity({ get: key => key === name ? value : valid.get(key) }, environment), null);
  }
});

test('untrusted optional name metadata falls back to email without changing authenticated ownership', () => {
  for (const extra of [
    { 'oai-authenticated-user-full-name': 'Person' },
    { 'oai-authenticated-user-full-name': '%E0%A4%A', 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8' },
    { 'oai-authenticated-user-full-name': 'First, Second', 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8' },
    { 'oai-authenticated-user-full-name': '%00Admin', 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8' },
    { 'oai-authenticated-user-full-name': 'a'.repeat(201), 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8' },
    { 'oai-authenticated-user-full-name': 'Admin', 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8, percent-encoded-utf-8' },
  ]) {
    assert.deepEqual(readPlatformIdentity(headers(extra), environment), { userId: 'site-owner_123', email: 'person@example.com', fullName: null, displayName: 'person@example.com' });
  }
});
