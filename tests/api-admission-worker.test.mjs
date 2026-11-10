import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(await realpath(new URL('../node_modules/wrangler/package.json', import.meta.url)));
const { Miniflare } = await import(pathToFileURL(require.resolve('miniflare')).href);
const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);
// The Worker and admission controller are the actual backport
// modules. Only the framework response is replaced with a bounded fixture.
const bundle = await build({
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', external: ['node:*'],
  define: { 'import.meta.env.DEV': 'false' },
  plugins: [{
    name: 'fixture-framework',
    setup(builder) {
      builder.onResolve({ filter: /^vinext\/server\/fetch-handler$/ }, () => ({ path: 'handler', namespace: 'fixture' }));
      builder.onLoad({ filter: /^handler$/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
        export default { async fetch(request) {
          const state = globalThis.admissionFixture;
          state.calls++;
          if (request.headers.get('x-fixture') === 'throw') throw new Error('private-provider-fixture');
          if (request.headers.get('x-fixture') === 'hold') await new Promise(resolve => state.pending.push(resolve));
          const body = request.body ? await request.text() : null;
          return Response.json({ body, nonce: request.headers.get('x-prism-script-nonce'), identity: Object.fromEntries([...request.headers].filter(([name]) => name.startsWith('oai-authenticated-user-'))) });
        } };
      ` }));
    },
  }],
  stdin: {
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
    contents: `
      import app from './build/sites-worker.ts';
      export default { async fetch(input, env, ctx) {
        const mode = new URL(input.url).pathname.slice(1);
        const state = globalThis.admissionFixture = { calls: 0, pending: [] };
        const events = [];
        const incoming = (path, fixture, tracked = false) => new Request('https://prism.test' + path, {
          method: path.includes('read') ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': '1', ...(fixture ? { 'x-fixture': fixture } : {}) },
          ...(path.includes('read') ? {} : { body: tracked ? new ReadableStream({
            pull(controller) { events.push('pull'); controller.enqueue(new TextEncoder().encode('x')); },
            cancel() { events.push('cancel'); },
          }, { highWaterMark: 0 }) : '{}' }),
        });
        const call = request => app.fetch(request, env, ctx);
        if (mode === 'identity') {
          const results = [];
          for (const [url, host, configured] of [
            ['https://prism.test/api/read', 'prism.test', 'https://prism.test'],
            ['https://other.workers.dev/api/read', 'other.workers.dev', 'https://prism.test'],
            ['https://other.workers.dev/api/read', 'prism.test', 'https://prism.test'],
            ['https://prism.test/api/read', 'prism.test', undefined],
          ]) {
            const response = await app.fetch(new Request(url, { headers: { host,
              'oai-authenticated-user-id': 'fixture-owner', 'oai-authenticated-user-email': 'fixture@example.test',
              'oai-authenticated-user-future-field': 'untrusted-claim', 'x-forwarded-host': 'prism.test' } }),
              { ...env, APP_ORIGIN: configured }, ctx);
            results.push(await response.json());
          }
          return Response.json(results);
        }
        if (mode === 'mutation') {
          const response = await call(incoming('/chat', null, true));
          return Response.json({ status: response.status, calls: state.calls, events, headers: Object.fromEntries(response.headers) });
        }
        if (mode === 'error') {
          const failed = await call(incoming('/api/files', 'throw', true));
          const failure = await failed.json();
          const held = Array.from({ length: 32 }, () => call(incoming('/api/read', 'hold')));
          await Promise.resolve();
          const acquired = state.pending.length;
          state.pending.splice(0).forEach(resolve => resolve());
          const released = await Promise.all(held);
          return Response.json({ status: failed.status, failure, acquired, statuses: released.map(response => response.status), events });
        }
        const upload = mode === 'body-limit';
        const path = upload ? '/api/media/reference' : '/api/read';
        const count = upload ? 3 : 32;
        const held = Array.from({ length: count }, () => call(incoming(path, 'hold')));
        await Promise.resolve();
        const overflow = await call(incoming(upload ? path : '/api/files', null, true));
        const snapshot = { status: overflow.status, body: await overflow.json(), calls: state.calls, events: [...events], headers: Object.fromEntries(overflow.headers) };
        const page = await call(new Request('https://prism.test/'));
        state.pending.splice(0).forEach(resolve => resolve());
        const released = await Promise.all(held);
        const replacement = await call(incoming(path));
        return Response.json({ ...snapshot, pageStatus: page.status, released: released.map(response => response.status), replacement: replacement.status });
      } };
    `,
  },
});
const worker = new Miniflare({
  modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
  script: bundle.outputFiles[0].text,
});
after(() => worker.dispose());

for (const mode of ['body-limit', 'request-limit']) test(`actual Workerd gate rejects ${mode} overflow before reading its stream and releases capacity`, async () => {
  const response = await worker.dispatchFetch('https://prism.test/' + mode);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'API_CAPACITY');
  assert.equal(result.calls, mode === 'body-limit' ? 3 : 32);
  assert.deepEqual(result.events, ['cancel']);
  assert.equal(result.pageStatus, 200);
  assert.equal(result.replacement, 200);
  assert.equal(result.released.every(status => status === 200), true);
  assert.equal(result.headers['retry-after'], '1');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.match(result.headers['cache-control'], /no-store/);
  assert.match(result.headers['content-security-policy'], /sandbox/);
});

test('actual Workerd error paths cancel the forwarded live stream, redact details, and free admission slots', async () => {
  const response = await worker.dispatchFetch('https://prism.test/error');
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.status, 500);
  assert.doesNotMatch(JSON.stringify(result.failure), /private-provider-fixture/);
  assert.match(result.failure.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(result.acquired, 32);
  assert.equal(result.statuses.every(status => status === 200), true);
  assert.equal(result.events.includes('cancel'), true);
});


test('actual Worker entry strips identity assertions on foreign, host-spoofed, and unconfigured ingress', async () => {
  const response = await worker.dispatchFetch('https://prism.test/identity');
  assert.equal(response.status, 200);
  const results = await response.json();
  assert.equal(results[0].identity['oai-authenticated-user-id'], 'fixture-owner');
  assert.equal(results[0].identity['oai-authenticated-user-email'], 'fixture@example.test');
  for (const result of results.slice(1)) assert.deepEqual(result.identity, {});
});
