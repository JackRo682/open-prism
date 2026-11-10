import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const runtime = new URL('../.sites-runtime/drive-security-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
const source = await readFile(new URL('../lib/drive-client.ts', import.meta.url), 'utf8');
await writeFile(new URL('drive-client.mjs', runtime), ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const { DriveAccessSession, DRIVE_SCOPE, MAX_DRIVE_FILE_BYTES, MAX_DRIVE_SESSION_MS, clearDriveTokenResponse, selectedDriveFile } = await import(new URL('drive-client.mjs', runtime));
const tokenValue = 'ya29.test-only-sensitive-access-token';
const grant = (override = {}) => ({ access_token: tokenValue, scope: DRIVE_SCOPE, expires_in: 3600, token_type: 'Bearer', ...override });
const authorized = t => { const session = new DriveAccessSession(); t.after(() => session.cancel()); assert.equal(session.acceptToken(grant()), true); return session; };
const metadata = (extra = {}) => Response.json({ id: 'file_123', name: 'sample.txt', mimeType: 'text/plain', size: '12', capabilities: { canDownload: true }, ...extra });
const fileUrl = 'https://www.googleapis.com/drive/v3/files/file_123?alt=media';

// The real lifecycle and transfer implementation run here. Only Google is a fixture.
test('only the requested per-file scope and an explicit usable expiry are accepted', t => {
  for (const override of [
    { scope: undefined }, { scope: '' }, { scope: 'https://www.googleapis.com/auth/drive' },
    { scope: DRIVE_SCOPE + ' https://www.googleapis.com/auth/drive.readonly' },
    { expires_in: undefined }, { expires_in: null }, { expires_in: 0 }, { expires_in: 30 },
    { expires_in: -1 }, { expires_in: Infinity }, { expires_in: NaN }, { expires_in: 'NaN' },
    { token_type: 'mac' }, { token_type: 12 }, { access_token: '' },
    { access_token: 'value\r\nX-Forged: header' }, { access_token: 'a'.repeat(8193) }, { error: 'access_denied' },
  ]) {
    const session = new DriveAccessSession();
    try { assert.throws(() => session.acceptToken(grant(override))); assert.throws(() => session.tokenForPicker()); }
    finally { session.cancel(); }
  }
  const session = authorized(t);
  assert.equal(session.tokenForPicker(), tokenValue);
  assert.equal(session.acceptToken(grant({ access_token: 'another-grant' })), false, 'a duplicate callback cannot swap the selected account');
  assert.equal(session.tokenForPicker(), tokenValue);
  assert.ok(!JSON.stringify(session).includes(tokenValue), 'incidental object serialization must not expose the token');
});

test('closed sessions reject late OAuth callbacks even after another dialog has opened', t => {
  const closed = authorized(t); closed.cancel();
  const reopened = authorized(t);
  assert.equal(closed.acceptToken(grant()), false);
  assert.throws(() => closed.tokenForPicker());
  assert.equal(reopened.tokenForPicker(), tokenValue);
  reopened.release();
  assert.throws(() => reopened.tokenForPicker());
  assert.equal(reopened.acceptToken(grant()), false, 'released grants are never reusable');
  const staleResponse = grant(); clearDriveTokenResponse(staleResponse);
  assert.equal(staleResponse.access_token, undefined);
  assert.doesNotThrow(() => clearDriveTokenResponse(Object.freeze(grant())), 'SDK-owned frozen objects cannot stop session cleanup');
});

test('authorization/picker sessions expire automatically, with a margin before Google expiry', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  const short = new DriveAccessSession(); t.after(() => short.cancel());
  assert.equal(short.acceptToken(grant({ expires_in: 40 })), true);
  t.mock.timers.tick(9999); assert.equal(short.signal.aborted, false);
  t.mock.timers.tick(1); assert.equal(short.signal.aborted, true);
  assert.equal(short.signal.reason.name, 'TimeoutError'); assert.throws(() => short.tokenForPicker());
  const waiting = new DriveAccessSession(); t.after(() => waiting.cancel());
  t.mock.timers.tick(MAX_DRIVE_SESSION_MS);
  assert.equal(waiting.acceptToken(grant()), false, 'a popup response after the session deadline is ignored');
  const long = authorized(t);
  t.mock.timers.tick(MAX_DRIVE_SESSION_MS);
  assert.equal(long.signal.aborted, true, 'a one-hour Google token is not kept for an hour');
});

test('expiry is checked before use even if the background tab delayed its timer', t => {
  const session = authorized(t), now = Date.now();
  t.mock.method(Date, 'now', () => now + MAX_DRIVE_SESSION_MS + 1);
  assert.throws(() => session.tokenForPicker());
  assert.equal(session.signal.aborted, true);
});

test('bearer credentials only go in Authorization to allowlisted Google routes', async t => {
  const session = authorized(t), calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return new Response('safe'); });
  session.beginTransfer();
  for (const url of [
    'https://evil.example/drive/v3/files/file_123?alt=media',
    'https://www.googleapis.com.evil.example/drive/v3/files/file_123?alt=media',
    'http://www.googleapis.com/drive/v3/files/file_123?alt=media',
    'https://user:secret@www.googleapis.com/drive/v3/files/file_123?alt=media',
    'https://www.googleapis.com/drive/v3/files/file_123?access_token=' + tokenValue,
    'https://www.googleapis.com/drive/v3/files/file_123#fragment',
    'https://www.googleapis.com/oauth2/v1/tokeninfo',
    'https://getopenprism.com/api/integrations/drive',
  ]) assert.throws(() => session.request(url));
  assert.equal(calls.length, 0);
  await session.request(fileUrl, { headers: { Authorization: 'attacker-controlled' }, credentials: 'include', redirect: 'follow', referrerPolicy: 'unsafe-url', signal: new AbortController().signal });
  const [{ url, init }] = calls;
  assert.equal(url, fileUrl); assert.ok(!url.includes(tokenValue));
  assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer ' + tokenValue);
  assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.cache, 'no-store'); assert.equal(init.mode, 'cors'); assert.equal(init.signal, session.signal);
  session.cancel(); assert.equal(init.signal.aborted, true);
  assert.throws(() => session.request(fileUrl)); assert.equal(calls.length, 1);
});

test('Docs export uses the same protected Google request boundary', async t => {
  const session = authorized(t); session.beginTransfer(60000);
  let request;
  t.mock.method(globalThis, 'fetch', async (url, init) => { request = { url, init }; return Response.json({ id: 'created' }); });
  await session.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=test' }, body: 'document-content' });
  assert.equal(request.init.body, 'document-content'); assert.ok(!request.url.includes(tokenValue));
  assert.equal(request.init.redirect, 'error'); assert.equal(request.init.credentials, 'omit');
  session.release(); assert.throws(() => session.tokenForPicker());
});

test('successful file import clears credentials before the application receives the File', async t => {
  const session = authorized(t), calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? metadata({ name: '../notes', size: '10' }) : new Response('Hello 안녕');
  });
  const file = await selectedDriveFile('file_123', session);
  assert.equal(await file.text(), 'Hello 안녕'); assert.equal(file.name, '.._notes.txt'); assert.equal(file.type, 'text/plain');
  assert.equal(calls.length, 2); assert.ok(calls.every(call => new URL(call.url).origin === 'https://www.googleapis.com'));
  assert.throws(() => session.tokenForPicker()); assert.equal(session.signal.aborted, false);
  assert.equal(session.acceptToken(grant()), false);
});

test('Google-native documents use only documented fixed export endpoints', async t => {
  for (const [mime, exportMime, extension] of [
    ['application/vnd.google-apps.document', 'text/plain', 'txt'],
    ['application/vnd.google-apps.spreadsheet', 'text/csv', 'csv'],
    ['application/vnd.google-apps.presentation', 'text/plain', 'txt'],
  ]) {
    const session = authorized(t), calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return calls.length === 1 ? metadata({ name: 'Document', mimeType: mime, size: undefined }) : new Response('export'); });
    const file = await selectedDriveFile('file_123', session);
    assert.equal(file.name, 'Document.' + extension); assert.equal(file.type, exportMime);
    const exportUrl = new URL(calls[1].url);
    assert.equal(exportUrl.pathname, '/drive/v3/files/file_123/export'); assert.equal(exportUrl.searchParams.get('mimeType'), exportMime);
    assert.throws(() => session.tokenForPicker());
  }
});

test('Drive titles normalize colon, C1 controls and bidi marks before server upload', async t => {
  const session = authorized(t); let count = 0;
  t.mock.method(globalThis, 'fetch', async () => ++count === 1
    ? metadata({ name: 'Project: notes\u0085\u202e\u2028\u2069', mimeType: 'application/vnd.google-apps.document', size: undefined }) : new Response('notes'));
  const file = await selectedDriveFile('file_123', session);
  assert.equal(file.name, 'Project_ notes____.txt');
  assert.doesNotMatch(file.name, /[\x00-\x1f\x7f-\x9f:\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
});

test('unsafe IDs, mismatched metadata, unsupported MIME and missing sizes never download data', async t => {
  for (const id of ['../private', 'file?access_token=other', '', 'a'.repeat(257)]) {
    const session = authorized(t);
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No outbound request expected'); });
    await assert.rejects(selectedDriveFile(id, session)); assert.equal(fetch.mock.callCount(), 0);
    assert.throws(() => session.tokenForPicker());
  }
  for (const invalid of [
    { id: 'other_file' }, { capabilities: { canDownload: false } }, { mimeType: 'text/x-malware' }, { mimeType: '__proto__' },
    { mimeType: 'constructor' }, { size: undefined }, { size: 'NaN' }, { size: '-1' }, { size: '9007199254740993' },
    { size: String(MAX_DRIVE_FILE_BYTES + 1) },
  ]) {
    const session = authorized(t), fetch = t.mock.method(globalThis, 'fetch', async () => metadata(invalid));
    await assert.rejects(selectedDriveFile('file_123', session)); assert.equal(fetch.mock.callCount(), 1);
    assert.throws(() => session.tokenForPicker());
  }
});

test('metadata and streamed documents remain bounded even without honest content lengths', async t => {
  const largeMetadataSession = authorized(t);
  const first = t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(16385)));
  await assert.rejects(selectedDriveFile('file_123', largeMetadataSession)); assert.equal(first.mock.callCount(), 1);
  assert.throws(() => largeMetadataSession.tokenForPicker());
  const session = authorized(t); let count = 0, cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => ++count === 1 ? metadata() : new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_DRIVE_FILE_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Length': '1' } }));
  await assert.rejects(selectedDriveFile('file_123', session));
  assert.equal(cancelled, true); assert.throws(() => session.tokenForPicker());
});

test('binary masquerades, invalid UTF-8, and access-denied responses clear the grant', async t => {
  for (const bytes of [new Uint8Array([0x61, 0, 0x62]), new Uint8Array([0xff, 0xfe])]) {
    const session = authorized(t); let count = 0;
    t.mock.method(globalThis, 'fetch', async () => ++count === 1 ? metadata() : new Response(bytes));
    await assert.rejects(selectedDriveFile('file_123', session)); assert.throws(() => session.tokenForPicker());
  }
  const session = authorized(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('Provider diagnostic that must not be displayed: ' + tokenValue, { status: 401 }));
  await assert.rejects(selectedDriveFile('file_123', session), error => !error.message.includes(tokenValue));
  assert.throws(() => session.tokenForPicker());
});

test('hung Google requests are aborted by the transfer deadline and cannot retain usable tokens', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const session = authorized(t); let requestSignal;
  t.mock.method(globalThis, 'fetch', (_url, init) => new Promise((_resolve, reject) => {
    requestSignal = init.signal;
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  const operation = selectedDriveFile('file_123', session);
  const rejected = assert.rejects(operation, { name: 'TimeoutError' });
  t.mock.timers.tick(30000);
  await rejected; assert.equal(requestSignal.aborted, true); assert.throws(() => session.tokenForPicker());
});
