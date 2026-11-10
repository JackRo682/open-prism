import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const output = new URL('../.sites-runtime/browser-network-tests/', import.meta.url);
await mkdir(output, { recursive: true });
const authorization = await readFile(new URL('../lib/authorization.ts', import.meta.url), 'utf8');
await writeFile(new URL('authorization.mjs', output), ts.transpileModule(authorization, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const source = (await readFile(new URL('../lib/browser-workspace.ts', import.meta.url), 'utf8')).replaceAll("'./authorization'", "'./authorization.mjs'");
await writeFile(new URL('browser.mjs', output), ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const { isPublicBrowserUrl, isPublicBrowserAddress, createBrowserDnsPolicy, BROWSER_CAPTURE_PROGRAM } = await import(new URL('browser.mjs', output));

function dnsFixture(answer = () => undefined) {
  const calls = [];
  const fetcher = async (value, options) => {
    const url = new URL(value);
    calls.push({ url, options });
    assert.equal(url.origin + url.pathname, 'https://cloudflare-dns.com/dns-query');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
    const type = url.searchParams.get('type') === 'A' ? 1 : 28;
    const hostname = url.searchParams.get('name');
    const records = answer(hostname, type, calls.length);
    if (records instanceof Response) return records;
    return Response.json({
      Status: 0, TC: false, CD: false, Question: [{ name: hostname + '.', type }],
      Answer: records === undefined ? (type === 1 ? [{ name: hostname + '.', type, data: '93.184.215.14' }] : []) : records,
    }, { headers: { 'Content-Type': 'application/dns-json' } });
  };
  return { calls, fetcher };
}
const policy = fixture => createBrowserDnsPolicy(isPublicBrowserUrl, isPublicBrowserAddress, fixture.fetcher);

test('URL policy rejects address encodings, private suffixes, parser ambiguity and protocol/port mismatches', () => {
  for (const value of ['https://example.com/', 'http://example.com:80/', 'https://example.com:443/', 'https://xn--bcher-kva.de/path']) {
    assert.equal(isPublicBrowserUrl(value), true, value);
  }
  for (const value of [
    'http://127.1/', 'http://0177.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::ffff:127.0.0.1]/',
    'http://host.local/', 'http://host.internal/', 'http://router.home.arpa/', 'http://metadata.google.internal/',
    'https://user:pass@example.com/', 'http://example.com:443/', 'https://example.com:80/',
    'https://example.com./', 'https://a..example.com/', 'https://-host.example.com/', 'https://host_.example.com/',
    'https://example.com/\\@localhost', 'https://example.com/\r\n', 'http://[2001:4860:4860::8888]/',
    'ftp://example.com/', 'file:///etc/passwd', 'data:text/html,hello', 'blob:https://example.com/id',
  ]) assert.equal(isPublicBrowserUrl(value), false, value);
});

test('resolved addresses exclude private, loopback, link-local, metadata, reserved, transition and documentation networks', () => {
  const blocked = [
    '0.0.0.0', '0.255.255.255', '10.1.2.3', '127.0.0.1', '127.255.255.254', '100.64.0.1', '100.127.255.254',
    '169.254.169.254', '172.16.0.1', '172.31.255.254', '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.1.1',
    '198.18.0.1', '198.19.255.254', '198.51.100.42', '203.0.113.5', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '168.63.129.16', '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::a00:1', '64:ff9b:1::1',
    'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '2001::1', '2001:2::1', '2001:20::1', '2001:db8::1',
    '2002:7f00:1::', '3fff:fff::1', '::ffff:169.254.169.254',
    '127.1', '0177.0.0.1', '010.1.2.3', '256.0.0.1', '8.8.8.8 ', 'public.example', '[::1]', 'fe80::1%eth0',
  ];
  for (const address of blocked) assert.equal(isPublicBrowserAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.215.14', '100.63.255.254', '100.128.0.1', '172.15.255.254', '172.32.0.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.equal(isPublicBrowserAddress(address), true, address);
  }
});

test('DNS validates both address families, rejects mixed public/private results and fails closed for empty or invalid data', async () => {
  assert.equal(await policy(dnsFixture())('https://example.com/'), true);
  assert.equal(await policy(dnsFixture((_host, type) => type === 1 ? [] : [{ type, data: '2606:4700:4700::1111' }]))('https://example.com/'), true);
  for (const records of [
    (_host, type) => type === 1 ? [{ type, data: '93.184.215.14' }, { type, data: '127.0.0.1' }] : [],
    (_host, type) => type === 28 ? [{ type, data: 'fd12::1234' }] : undefined,
    (_host, type) => type === 1 ? [{ type: 5, data: 'metadata.google.internal.' }, { type, data: '93.184.215.14' }] : [],
    () => [],
    () => new Response('{}', { status: 503 }),
    () => Response.json({ Status: 3, TC: false }, { headers: { 'Content-Type': 'application/dns-json' } }),
    () => new Response('{broken', { headers: { 'Content-Type': 'application/dns-json' } }),
    () => new Response('x'.repeat(16385), { headers: { 'Content-Type': 'application/dns-json' } }),
    () => Response.json({ Status: 0, TC: false, Question: [{ name: 'different.example.', type: 1 }], Answer: [{ type: 1, data: '8.8.8.8' }] }, { headers: { 'Content-Type': 'application/dns-json' } }),
  ]) assert.equal(await policy(dnsFixture(records))('https://example.com/'), false);
});

test('DNS never falls back on failure, never reuses settled positive results, and bounds hosts and lookups', async () => {
  let failedCalls = 0;
  const unavailable = createBrowserDnsPolicy(isPublicBrowserUrl, isPublicBrowserAddress, async () => { failedCalls++; throw new Error('Resolver down'); });
  assert.equal(await unavailable('https://example.com/'), false);
  assert.equal(failedCalls, 2);
  const changing = dnsFixture((_host, type, call) => type === 1 ? [{ type, data: call <= 2 ? '8.8.8.8' : '127.0.0.1' }] : []);
  const checkChanging = policy(changing);
  assert.equal(await checkChanging('https://example.com/'), true);
  assert.equal(await checkChanging('https://example.com/next'), false);
  assert.equal(changing.calls.length, 4);
  const hosts = dnsFixture(), checkHosts = policy(hosts);
  for (let i = 0; i < 32; i++) assert.equal(await checkHosts(`https://h${i}.example.com/`), true);
  assert.equal(await checkHosts('https://h32.example.com/'), false);
  assert.equal(hosts.calls.length, 64);
  const budget = dnsFixture(), checkBudget = policy(budget);
  for (let i = 0; i < 128; i++) assert.equal(await checkBudget('https://example.com/' + i), true);
  assert.equal(await checkBudget('https://example.com/overflow'), false);
  assert.equal(budget.calls.length, 256);
});

async function runProgram({ program = BROWSER_CAPTURE_PROGRAM, dns = dnsFixture(), url = 'https://example.com/', finalUrl = url, requests = [], hang, hangClose = false } = {}) {
  const events = new Map(), decisions = [], settings = {}, frame = {};
  let visited = 0, closed = 0, deadlineCallback, deadlineCleared = false;
  const setTimer = (callback, delay) => { assert.equal(delay, 30000); deadlineCallback = callback; return 1; };
  const clearTimer = timer => { assert.equal(timer, 1); deadlineCleared = true; };
  const never = () => { queueMicrotask(() => deadlineCallback()); return new Promise(() => {}); };
  const page = {
    async setViewport(value) { settings.viewport = value; },
    async setJavaScriptEnabled(value) { settings.javascript = value; },
    async setBypassServiceWorker(value) { settings.bypassServiceWorker = value; },
    async setCacheEnabled(value) { settings.cache = value; },
    async createCDPSession() { return { async send(method, value) { settings[method] = value; } }; },
    async setRequestInterception(value) { settings.interception = value; },
    on(event, callback) { events.set(event, callback); },
    mainFrame() { return frame; },
    async goto(value) {
      visited++;
      assert.equal(settings.javascript, false);
      assert.equal(settings.bypassServiceWorker, true);
      assert.equal(settings.cache, false);
      assert.deepEqual(settings['Browser.setDownloadBehavior'], { behavior: 'deny' });
      assert.equal(settings.interception, true);
      const initial = await emit({ url: value, kind: 'document' });
      if (initial.action !== 'continue') throw new Error('Navigation aborted');
      for (const request of requests) await emit(request);
      return { status: () => 200 };
    },
    async waitForNetworkIdle() {},
    url() { return finalUrl; },
    async evaluate() { if (hang === 'evaluate') return never(); return { url: finalUrl, title: 'Public page', text: 'Public text', links: [] }; },
    async screenshot() { if (hang === 'screenshot') return never(); return '/9j/'; },
    async close() { closed++; if (hangClose) return new Promise(() => {}); },
  };
  async function emit({ url: value, method = 'GET', kind = 'image', childFrame = false, redirects = 0 }) {
    const decision = { url: value, action: null };
    decisions.push(decision);
    await events.get('request')({
      url: () => value, method: () => method, resourceType: () => kind,
      redirectChain: () => Array(redirects), frame: () => childFrame ? {} : frame,
      async continue() { decision.action = 'continue'; }, async abort() { decision.action = 'abort'; },
    });
    return decision;
  }
  const execute = new Function('fetch', 'setTimeout', 'clearTimeout', program.replace('export default', 'return'))(dns.fetcher, setTimer, clearTimer);
  try { return { result: await execute({ page, context: { url } }), decisions, settings, visited, closed, deadlineCleared }; }
  catch (error) { return { error, decisions, settings, visited, closed, deadlineCleared }; }
}

test('actual remote program rejects unsafe DNS before navigation', async () => {
  const response = await runProgram({ dns: dnsFixture((_host, type) => type === 1 ? [{ type, data: '169.254.169.254' }] : []) });
  assert.match(response.error.message, /Unsupported navigation/);
  assert.equal(response.visited, 0);
  assert.deepEqual(response.decisions, []);
});

test('actual remote program checks redirects/subresources and excludes actions, frames, sockets, workers and scripts', async () => {
  const dns = dnsFixture((host, type) => host === 'private.example.com' && type === 1 ? [{ type, data: '10.0.0.5' }] : undefined);
  const response = await runProgram({ dns, requests: [
    { url: 'https://cdn.example.com/image.png', kind: 'image' },
    { url: 'https://cdn.example.com/style.css', kind: 'stylesheet' },
    { url: 'https://cdn.example.com/font.woff2', kind: 'font' },
    { url: 'https://private.example.com/metadata', kind: 'document', redirects: 1 },
    { url: 'https://private.example.com/internal.png', kind: 'image' },
    { url: 'http://127.0.0.1/metadata', kind: 'image' },
    { url: 'http://169.254.169.254/latest/meta-data/', kind: 'document', redirects: 1 },
    { url: 'https://example.com/long-redirect', kind: 'document', redirects: 6 },
    { url: 'https://example.com/child', kind: 'document', childFrame: true },
    { url: 'https://example.com/change', method: 'POST', kind: 'document' },
    ...['script', 'xhr', 'fetch', 'eventsource', 'websocket', 'other', 'media'].map(kind => ({ url: 'https://example.com/resource', kind })),
  ] });
  assert.ifError(response.error);
  assert.equal(response.result.data.text, 'Public text');
  assert.equal(response.closed, 1);
  assert.equal(response.deadlineCleared, true);
  assert.deepEqual(response.decisions.slice(0, 4).map(item => item.action), Array(4).fill('continue'));
  assert.equal(response.decisions.slice(4).every(item => item.action === 'abort'), true);
});

test('actual remote program revalidates final redirected URL and bounds excessive resource requests', async () => {
  const denied = await runProgram({ finalUrl: 'https://private.example.com/', dns: dnsFixture((host, type) => host === 'private.example.com' && type === 1 ? [{ type, data: '127.0.0.1' }] : undefined) });
  assert.match(denied.error.message, /Unsupported redirect/);
  assert.equal(denied.closed, 1);
  // Exceed the HTTP request budget with rejected resource types so the DNS budget does not mask it.
  const limited = await runProgram({ requests: [...Array.from({ length: 128 }, () => ({ url: 'https://example.com/script.js', kind: 'script' })), { url: 'https://example.com/last.png', kind: 'image' }] });
  assert.ifError(limited.error);
  assert.equal(limited.decisions.at(-1).action, 'abort');
  assert.equal(limited.closed, 1);
});


test('remote program survives production minification with preserved function names', async () => {
  const require = createRequire(await realpath(new URL('../node_modules/wrangler/package.json', import.meta.url)));
  const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);
  for (const keepNames of [false, true]) {
    const bundle = await build({ entryPoints: [fileURLToPath(new URL('../lib/browser-workspace.ts', import.meta.url))],
      bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', minify: true, keepNames });
    const compiled = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
    const result = await runProgram({ program: compiled.BROWSER_CAPTURE_PROGRAM });
    assert.ifError(result.error);
    assert.equal(result.result.data.text, 'Public text');
    assert.equal(result.closed, 1);
    const denied = await runProgram({ program: compiled.BROWSER_CAPTURE_PROGRAM,
      dns: dnsFixture((_host, type) => type === 1 ? [{ type, data: '127.0.0.1' }] : []) });
    assert.match(denied.error.message, /Unsupported navigation/);
    assert.equal(denied.visited, 0);
  }
});


for (const hang of ['evaluate', 'screenshot']) test('whole-capture watchdog closes the page and rejects a never-resolving ' + hang, { timeout: 2000 }, async () => {
  for (const hangClose of [false, true]) {
    const response = await runProgram({ hang, hangClose });
    assert.match(response.error?.message || '', /Remote page capture timed out/);
    assert.equal(response.result, undefined);
    assert.equal(response.closed, 1);
    assert.equal(response.deadlineCleared, true);
  }
});
