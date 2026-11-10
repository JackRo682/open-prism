import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercise the deployed runtime boundary, not Node's Request implementation.
// Wrangler already supplies both dependencies; no extra install is required.
const require = createRequire(await realpath(new URL('../node_modules/wrangler/package.json', import.meta.url)));
const { Miniflare } = await import(pathToFileURL(require.resolve('miniflare')).href);
const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);
const bundle = await build({
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', external: ['node:*'],
  stdin: {
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
    contents: `
      import { createTrackedAppRouteRequest } from './node_modules/vinext/dist/server/app-route-handler-runtime.js';
      import { prepareSecureRequest } from './lib/http-security.ts';
      import { boundedApiRequest, sameOriginMutation } from './lib/request-security.ts';
      export default { async fetch(input) {
        try {
        const aborter = new AbortController();
        const native = new Request(input, { signal: aborter.signal, redirect: 'manual' });
        const secure = prepareSecureRequest(native);
        const metadata = input.headers.get('x-fixture-cf');
        let metadataReads = 0;
        if (metadata === 'null' || metadata === 'undefined') Object.defineProperty(secure.request, 'cf', {
          value: metadata === 'null' ? null : undefined, configurable: true,
        });
        if (metadata === 'throw') Object.defineProperty(secure.request, 'cf', {
          get() { metadataReads++; throw new TypeError('fixture-private-metadata'); }, configurable: true,
        });
        const request = createTrackedAppRouteRequest(secure.request).request;
        if (!sameOriginMutation(request)) return Response.json({ code: 'INVALID_ORIGIN' }, { status: 403 });
          const bounded = await boundedApiRequest(request);
          const body = bounded.headers.get('content-type').startsWith('multipart/form-data')
            ? await (await bounded.formData()).get('file').text() : await bounded.text();
          aborter.abort();
          if (metadata === 'throw') {
            const readsDuringBody = metadataReads;
            let accessorPreserved = false;
            try { void bounded.cf; } catch (error) { accessorPreserved = error instanceof TypeError; }
            return Response.json({ body, readsDuringBody, accessorPreserved, metadataReads, aborted: bounded.signal.aborted });
          }
          return Response.json({
            body, method: bounded.method, url: bounded.url, redirect: bounded.redirect,
            cookie: bounded.headers.get('cookie'), identity: bounded.headers.get('x-fixture-identity'),
            country: bounded.cf?.country, cfKind: bounded.cf === null ? 'null' : bounded.cf === undefined ? 'undefined' : 'object',
            aborted: bounded.signal.aborted,
            nonce: bounded.headers.get('x-prism-script-nonce'),
          });
        } catch (error) {
          return Response.json({ code: error.code, error: error.message }, { status: error.status ?? 500 });
        }
      } };
    `,
  },
});
const worker = new Miniflare({
  modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
  script: bundle.outputFiles[0].text,
});
after(() => worker.dispose());

const headers = { 'content-type': 'application/json', origin: 'https://prism.test', 'sec-fetch-site': 'same-origin' };

test('Workerd accepts real Vinext tracked chat requests and preserves identity, edge metadata, and cancellation', async () => {
  for (const path of ['/api/chat?fixture=1', '/api/guest/chat']) {
    const payload = JSON.stringify({ prompt: '한글 request body', model: 'gpt-6.1-sol' });
    const response = await worker.dispatchFetch('https://prism.test' + path, {
      method: 'POST', body: payload, cf: { country: 'KR' },
      headers: { ...headers, cookie: 'fixture-cookie=private', 'x-fixture-identity': 'alice' },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.body, payload);
    assert.equal(result.method, 'POST');
    assert.equal(result.url, 'https://prism.test' + path);
    assert.equal(result.redirect, 'manual');
    assert.equal(result.cookie, 'fixture-cookie=private');
    assert.equal(result.identity, 'alice');
    assert.equal(result.country, 'KR');
    assert.equal(result.aborted, true);
    assert.match(result.nonce, /^[A-Za-z0-9+/]{32}$/);
  }
});

test('Workerd retains multipart parsing after checking the original upload stream', async () => {
  const boundary = 'prism-fixture-boundary';
  const body = '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\n한글 file text\r\n--' + boundary + '--\r\n';
  const response = await worker.dispatchFetch('https://prism.test/api/files', {
    method: 'POST', body, headers: { ...headers, 'content-type': 'multipart/form-data; boundary=' + boundary },
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).body, '한글 file text');
});

test('Workerd preserves absent and null service-binding metadata without interpreting it as RequestInit.cf', async () => {
  for (const cfKind of ['null', 'undefined']) {
    const response = await worker.dispatchFetch('https://prism.test/api/chat', {
      method: 'POST', body: '{"prompt":"service-binding fixture"}', headers: { ...headers, 'x-fixture-cf': cfKind },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.cfKind, cfKind);
    assert.equal(result.body, '{"prompt":"service-binding fixture"}');
    assert.equal(result.aborted, true);
  }
});

test('Workerd reads a tracked request body without evaluating a throwing optional cf accessor', async () => {
  const response = await worker.dispatchFetch('https://prism.test/api/chat', {
    method: 'POST', body: '{"prompt":"hosted accessor fixture"}', headers: { ...headers, 'x-fixture-cf': 'throw' },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.body, '{"prompt":"hosted accessor fixture"}');
  assert.equal(result.readsDuringBody, 0);
  assert.equal(result.accessorPreserved, true);
  assert.equal(result.metadataReads, 1);
  assert.equal(result.aborted, true);
});

test('Workerd tracked requests still enforce origin, byte limits, content type, encoding, and valid UTF-8', async () => {
  for (const [body, overrides, status, code] of [
    ['{}', { origin: 'https://foreign.test' }, 403, 'INVALID_ORIGIN'],
    ['a'.repeat(100001), {}, 413, 'REQUEST_TOO_LARGE'],
    ['{}', { 'content-type': 'text/plain' }, 415, 'UNSUPPORTED_CONTENT_TYPE'],
    ['{}', { 'content-encoding': 'gzip' }, 415, 'UNSUPPORTED_CONTENT_ENCODING'],
    [new Uint8Array([0xc3, 0x28]), {}, 400, 'INVALID_UTF8'],
  ]) {
    const response = await worker.dispatchFetch('https://prism.test/api/chat', {
      method: 'POST', body, headers: { ...headers, ...overrides },
    });
    assert.equal(response.status, status, await response.clone().text());
    assert.equal((await response.json()).code, code);
  }
});

test('Workerd blocks null/missing origins and all Fetch Metadata except same-origin or absent', async () => {
  for (const changes of [
    { origin: null }, { origin: 'null' }, { origin: 'https://prism.test.evil.example' },
    { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'none' }, { 'sec-fetch-site': 'unknown' },
    { 'sec-fetch-site': 'same-origin, cross-site' },
  ]) {
    const requestHeaders = new Headers(headers);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) requestHeaders.delete(key); else requestHeaders.set(key, value);
    }
    const response = await worker.dispatchFetch('https://prism.test/api/chat', {
      method: 'POST', body: '{}', headers: requestHeaders,
    });
    assert.equal(response.status, 403, JSON.stringify(changes));
    assert.equal((await response.json()).code, 'INVALID_ORIGIN');
  }
  // The transport can normalize an empty header to absence. Origin remains
  // mandatory in that case, just as with older browsers without Fetch Metadata.
  const legacyHeaders = new Headers(headers); legacyHeaders.delete('sec-fetch-site');
  const allowed = await worker.dispatchFetch('https://prism.test/api/chat', {
    method: 'POST', body: '{}', headers: legacyHeaders,
  });
  assert.equal(allowed.status, 200);
});
