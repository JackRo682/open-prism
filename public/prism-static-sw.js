/* Cache only public, content-hashed build assets. Documents and APIs always use the network. */
const CACHE_PREFIX = 'prism-static-assets-';
const CACHE_NAME = CACHE_PREFIX + 'v1';
const MAX_ENTRIES = 64;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_WARM_URLS = 32;
const BACKGROUND_TIMEOUT_MS = 10000;
const SIZE_HEADER = 'X-Prism-Static-Bytes';
let writes = Promise.resolve();
let warming = Promise.resolve();

function assetUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || url.search || url.hash || url.username || url.password) return null;
    return /^\/_next\/static\/chunks\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js$/.test(url.pathname)
      || /^\/_next\/static\/css\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}\.css$/.test(url.pathname) ? url : null;
  } catch { return null; }
}

function correctType(url, response) {
  const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  return url.pathname.endsWith('.css') ? type === 'text/css' : ['text/javascript', 'application/javascript'].includes(type);
}

function publicResponse(url, response) {
  const policy = response.headers.get('Cache-Control') || '';
  const vary = response.headers.get('Vary') || '';
  return response.status === 200 && response.type === 'basic' && !response.redirected
    && response.url === url.href && correctType(url, response)
    && /(?:^|,)\s*public\s*(?:,|$)/i.test(policy)
    && !/(?:^|,)\s*(?:private|no-store)\b/i.test(policy)
    && !/(?:^|,)\s*(?:\*|cookie|authorization)\s*(?:,|$)/i.test(vary);
}

function cachedSize(response) {
  const raw = response?.headers.get(SIZE_HEADER) || '';
  const size = /^\d+$/.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(size) && size > 0 && size <= MAX_ASSET_BYTES ? size : 0;
}

async function fromCache(url) {
  try {
    const response = await (await caches.open(CACHE_NAME)).match(url.href);
    return response?.status === 200 && correctType(url, response) && cachedSize(response) ? response : null;
  } catch { return null; }
}

async function boundedBody(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new Error('Background asset read timed out.'));
    }, BACKGROUND_TIMEOUT_MS);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ASSET_BYTES) { void reader.cancel().catch(() => {}); return null; }
        chunks.push(value);
      }
      if (!size) return null;
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return body;
    })()]);
  } finally { clearTimeout(timeout); }
}

function saveAsset(url, response) {
  if (!publicResponse(url, response)) return Promise.resolve(false);
  const task = writes.then(async () => {
    const body = await boundedBody(response);
    if (!body) return false;
    const cache = await caches.open(CACHE_NAME);
    const entries = [];
    let total = 0;
    for (const key of await cache.keys()) {
      const size = cachedSize(await cache.match(key));
      if (!assetUrl(key.url) || !size || key.url === url.href) { await cache.delete(key); continue; }
      entries.push({ key, size }); total += size;
    }
    while (entries.length >= MAX_ENTRIES || total + body.byteLength > MAX_TOTAL_BYTES) {
      const oldest = entries.shift();
      if (!oldest) break;
      await cache.delete(oldest.key); total -= oldest.size;
    }
    // Retain no cookie, identity, request, or provider headers. The body is
    // decoded by fetch, so do not preserve the wire Content-Encoding/Length.
    await cache.put(url.href, new Response(body, { headers: {
      'Content-Type': response.headers.get('Content-Type'),
      'Content-Length': String(body.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      [SIZE_HEADER]: String(body.byteLength),
    } }));
    return true;
  }).catch(() => false);
  writes = task.then(() => undefined);
  return task;
}

self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
      }
    } catch { /* Cache storage can be unavailable without breaking the app. */ }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = assetUrl(request.url);
  if (!url || request.method !== 'GET' || request.mode === 'navigate'
    || request.headers.has('Authorization') || request.headers.has('Range')) return;
  // Register the lifetime promise synchronously; caching never delays response delivery.
  let settle;
  event.waitUntil(new Promise(resolve => { settle = resolve; }));
  event.respondWith((async () => {
    try {
      const cached = await fromCache(url);
      if (cached) { settle(); return cached; }
      const response = await fetch(request);
      void saveAsset(url, response.clone()).finally(settle);
      return response;
    } catch (error) { settle(); throw error; }
  })());
});

self.addEventListener('message', event => {
  const data = event.data;
  if (event.origin !== self.location.origin || data?.type !== 'PRISM_STATIC_WARM_V1'
    || !Array.isArray(data.urls) || data.urls.length > MAX_WARM_URLS
    || typeof data.requestId !== 'string' || data.requestId.length > 100 || !event.source?.id) return;
  event.waitUntil((async () => {
    const client = await self.clients.get(event.source.id);
    if (!client || client.type !== 'window' || new URL(client.url).origin !== self.location.origin) return;
    const urls = [...new Set(data.urls.filter(value => typeof value === 'string' && value.length < 2048)
      .map(value => assetUrl(value)?.href).filter(Boolean))];
    const task = warming.then(async () => {
      let cursor = 0, cachedCount = 0;
      async function next() {
        while (cursor < urls.length) {
          const url = new URL(urls[cursor++]);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), BACKGROUND_TIMEOUT_MS);
          try {
            if (await fromCache(url)) { cachedCount++; continue; }
            const response = await fetch(new Request(url.href, {
              credentials: 'omit', mode: 'same-origin', redirect: 'error', signal: controller.signal,
            }));
            if (await saveAsset(url, response)) cachedCount++;
          } catch { /* Speculative warming must never affect the active page. */ }
          finally { clearTimeout(timeout); }
        }
      }
      await Promise.all([next(), next()]);
      client.postMessage({ type: 'PRISM_STATIC_WARMED_V1', requestId: data.requestId, cachedCount, requestedCount: urls.length });
    });
    warming = task.catch(() => {});
    await warming;
  })().catch(() => {}));
});
