import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Execute the shipped worker; only the browser network/Cache/Clients boundaries
// are replaced. No application API, credentials, or real account is contacted.
const code = await readFile(new URL('../public/prism-static-sw.js', import.meta.url), 'utf8');
const origin = 'https://prism.test';
const asset = (hash = '12345678') => origin + '/_next/static/chunks/app-' + hash + '.js';
const currentCache = 'prism-static-assets-v1';
function networkResponse(url, body = 'export const value = 1;', options = {}) {
  const response = new Response(body, { status: options.status ?? 200, headers: {
    'Content-Type': options.mime ?? (url.endsWith('.css') ? 'text/css' : 'text/javascript'),
    'Cache-Control': options.policy ?? 'public, max-age=0, must-revalidate',
    'X-Private-Account': 'must-not-persist', ...options.headers,
  } });
  function stamp(value) {
    Object.defineProperties(value, {
      url: { value: options.finalUrl ?? url }, type: { value: options.type ?? 'basic' },
      redirected: { value: options.redirected ?? false },
    });
    const clone = value.clone.bind(value);
    value.clone = () => stamp(clone());
    return value;
  }
  return stamp(response);
}

function runtime(options = {}) {
  const handlers = new Map(), stores = new Map(), requests = [], messages = [], deleted = [];
  let claims = 0, skipped = 0;
  const storage = {
    async open(name) {
      if (options.failure === 'open') throw new Error('Storage denied');
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name), key = value => typeof value === 'string' ? value : value.url;
      return {
        async match(value) { if (options.failure === 'match') throw new Error('Read denied'); return entries.get(key(value))?.clone(); },
        async put(value, response) { if (options.failure === 'put') throw new Error('Quota exceeded'); entries.set(key(value), response.clone()); },
        async keys() { if (options.failure === 'keys') throw new Error('Read denied'); return [...entries.keys()].map(url => new Request(url)); },
        async delete(value) { return entries.delete(key(value)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deleted.push(name); return stores.delete(name); },
  };
  const client = { id: 'window-1', type: 'window', url: origin + '/', postMessage: data => messages.push(data) };
  const self = {
    location: { origin }, addEventListener: (type, callback) => handlers.set(type, callback),
    skipWaiting: async () => { skipped++; },
    clients: { claim: async () => { claims++; }, get: async id => id === client.id ? client : undefined },
  };
  const context = vm.createContext({ self, caches: storage, Response, Request, Headers, URL,
    AbortController, setTimeout: (callback, ms) => setTimeout(callback, options.fastTimers ? Math.min(ms, 20) : ms), clearTimeout,
    fetch: async request => {
      requests.push(request);
      return options.fetch ? options.fetch(request) : networkResponse(request.url);
    },
  });
  vm.runInContext(code, context, { filename: 'prism-static-sw.js' });
  async function dispatch(type, properties = {}) {
    let handled = false, response;
    const lifetime = [];
    handlers.get(type)({ ...properties, waitUntil: value => lifetime.push(value),
      respondWith: value => { handled = true; response = value; } });
    const result = response ? await response : undefined;
    await Promise.all(lifetime);
    return { handled, response: result };
  }
  return { dispatch, stores, requests, messages, deleted, client,
    lifecycle: () => ({ claims, skipped }),
    fetch: request => dispatch('fetch', { request: typeof request === 'string' ? new Request(request) : request }),
    warm: (urls, extra = {}) => dispatch('message', { origin, source: { id: client.id },
      data: { type: 'PRISM_STATIC_WARM_V1', requestId: 'test-request', urls }, ...extra }),
  };
}

test('documents, APIs, auth, private resources and non-hashed requests pass through untouched', async () => {
  const worker = runtime();
  const requests = [
    ...['/', '/chat', '/api/bootstrap', '/api/billing', '/api/files/id', '/signin-with-chatgpt', '/callback', '/_next/static/chunks/app.js'].map(path => new Request(origin + path)),
    new Request('https://other.test/_next/static/chunks/app-12345678.js'),
    new Request(asset() + '?account=secret'), new Request(asset(), { method: 'POST', body: 'payload' }),
    new Request(asset(), { headers: { Authorization: 'Bearer private' } }),
    new Request(asset(), { headers: { Range: 'bytes=0-99' } }),
  ];
  const navigation = new Request(asset()); Object.defineProperty(navigation, 'mode', { value: 'navigate' }); requests.push(navigation);
  for (const request of requests) assert.equal((await worker.fetch(request)).handled, false);
  assert.equal(worker.requests.length, 0); assert.equal(worker.stores.size, 0);
});

test('a verified public hash is fetched once, strips sensitive headers, and new hashes fetch new code', async () => {
  const worker = runtime();
  const first = await worker.fetch(asset()); assert.equal(first.handled, true);
  assert.equal(await first.response.text(), 'export const value = 1;');
  const cached = await worker.fetch(asset());
  assert.equal(await cached.response.text(), 'export const value = 1;');
  assert.equal(cached.response.headers.get('X-Private-Account'), null);
  assert.equal(cached.response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(worker.requests.length, 1);
  await worker.fetch(asset('87654321')); assert.equal(worker.requests.length, 2);
  assert.equal(worker.stores.get(currentCache).size, 2);
});

test('HTML, RSC, errors, opaque, redirects, private and identity-varying responses are never cached', async () => {
  for (const options of [
    { status: 404 }, { mime: 'text/html' }, { mime: 'text/x-component' }, { mime: 'application/json' },
    { type: 'opaque' }, { redirected: true }, { finalUrl: origin + '/signin-with-chatgpt' },
    { policy: 'private, no-store' }, { policy: 'public, no-store' }, { policy: 'max-age=60' },
    { headers: { Vary: 'Cookie' } }, { headers: { Vary: 'Authorization' } }, { headers: { Vary: '*' } },
  ]) {
    const worker = runtime({ fetch: async request => networkResponse(request.url, 'untrusted body', options) });
    await worker.fetch(asset()); await worker.fetch(asset());
    assert.equal(worker.requests.length, 2, JSON.stringify(options));
    assert.equal(worker.stores.get(currentCache)?.size ?? 0, 0, JSON.stringify(options));
  }
});

test('unavailable Cache APIs and quota failures preserve the real network response', async () => {
  for (const failure of ['open', 'match', 'keys', 'put']) {
    const worker = runtime({ failure });
    const result = await worker.fetch(asset());
    assert.equal(await result.response.text(), 'export const value = 1;', failure);
  }
});

test('entry count, total bytes, and oversized single responses are bounded', async () => {
  const worker = runtime();
  for (let index = 0; index < 70; index++) await worker.fetch(asset(String(index).padStart(8, '0')));
  const entries = worker.stores.get(currentCache);
  assert.equal(entries.size, 64); assert.equal(entries.has(asset('00000000')), false);
  const large = runtime({ fetch: async request => networkResponse(request.url, 'a'.repeat(2 * 1024 * 1024)) });
  for (let index = 0; index < 5; index++) await large.fetch(asset(String(index).padStart(8, '0')));
  assert.equal(large.stores.get(currentCache).size, 4);
  const oversized = runtime({ fetch: async request => networkResponse(request.url, 'a'.repeat(2 * 1024 * 1024 + 1)) });
  await oversized.fetch(asset()); assert.equal(oversized.stores.get(currentCache)?.size ?? 0, 0);
});

test('activation replaces only our versioned caches and claims clients without caching documents', async () => {
  const worker = runtime();
  worker.stores.set('prism-static-assets-v0', new Map()); worker.stores.set('unrelated-private-cache', new Map());
  await worker.dispatch('install'); await worker.dispatch('activate');
  assert.deepEqual(worker.deleted, ['prism-static-assets-v0']);
  assert.equal(worker.stores.has('unrelated-private-cache'), true);
  assert.deepEqual(worker.lifecycle(), { claims: 1, skipped: 1 });
});

test('warming validates the sending window/origin and only fetches bounded public hash URLs without credentials', async () => {
  const worker = runtime();
  await worker.warm([asset()], { origin: 'https://other.test' });
  await worker.warm([asset()], { source: { id: 'unknown' } });
  worker.client.url = 'https://other.test/'; await worker.warm([asset()]); worker.client.url = origin + '/';
  assert.equal(worker.requests.length, 0);
  await worker.warm([asset(), origin + '/api/billing', origin + '/signin-with-chatgpt', asset() + '?token=secret', 'https://other.test/_next/static/chunks/a-12345678.js']);
  assert.equal(worker.requests.length, 1); assert.equal(worker.requests[0].credentials, 'omit');
  assert.equal(worker.messages[0].cachedCount, 1); assert.equal(worker.messages[0].requestedCount, 1);
  await worker.warm(Array.from({ length: 33 }, () => asset())); assert.equal(worker.messages.length, 1);
});

test('a stalled speculative fetch times out and does not hold later warming batches', async () => {
  let first = true, aborted = false;
  const worker = runtime({ fastTimers: true, fetch: request => {
    if (!first) return networkResponse(request.url);
    first = false;
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); }));
  } });
  await worker.warm([asset()]); assert.equal(aborted, true); assert.equal(worker.messages[0].cachedCount, 0);
  await worker.warm([asset('87654321')]); assert.equal(worker.messages[1].cachedCount, 1);
});

test('a stalled cache-body read stops waiting without aborting the page response', async () => {
  let producer, first = true;
  const worker = runtime({ fastTimers: true, fetch: async request => {
    if (!first) return networkResponse(request.url);
    first = false;
    return networkResponse(request.url, new ReadableStream({ start(controller) {
      producer = controller; controller.enqueue(new TextEncoder().encode('first'));
    } }));
  } });
  const result = await worker.fetch(asset());
  assert.equal(worker.stores.get(currentCache)?.size ?? 0, 0);
  producer.enqueue(new TextEncoder().encode('-continued')); producer.close();
  assert.equal(await result.response.text(), 'first-continued');
  await worker.fetch(asset('87654321')); assert.equal(worker.stores.get(currentCache).size, 1);
});

test('network failures remain failures instead of fabricated offline success', async () => {
  const worker = runtime({ fetch: async () => { throw new Error('Network unavailable'); } });
  await assert.rejects(worker.fetch(asset()), /Network unavailable/);
  assert.equal(worker.stores.get(currentCache)?.size ?? 0, 0);
});
