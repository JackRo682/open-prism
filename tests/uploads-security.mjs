import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import ts from 'typescript';

const directory = new URL('../.sites-runtime/uploads-security-tests/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const name of ['workspace-tools', 'upload-security', 'upload-validation', 'image-validation']) {
  const source = (await readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'))
    .replaceAll("'./workspace-tools'", "'./workspace-tools.mjs'")
    .replaceAll("'./upload-security'", "'./upload-security.mjs'");
  await writeFile(new URL(name + '.mjs', directory), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const { readSingleFileUpload, validateTextUpload, MAX_TEXT_UPLOAD_BYTES, safeDownloadName, attachmentDisposition, untrustedContentHeaders } = await import(new URL('upload-validation.mjs', directory));
const { validateImageStructure, validateReferenceImage } = await import(new URL('image-validation.mjs', directory));
const invalid = error => error?.code === 'INVALID_REFERENCE_IMAGE';
const bytes = value => new Uint8Array(Buffer.from(value, 'base64'));
const knownPng = bytes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=');
// Actual images encoded by libjpeg/libwebp through Pillow; no fabricated headers.
const jpeg = bytes('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDLooor7g6D/9k=');
const progressiveJpeg = bytes('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAVAQEBAAAAAAAAAAAAAAAAAAADBf/aAAwDAQACEAMQAAABlFxP/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAD/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=');
const webp = bytes('UklGRjYAAABXRUJQVlA4ICoAAABwAQCdASoCAAIAAUAmJaACdAFAAAD+6tR//YO//84D//nAf0wWygTzQAA=');
const losslessWebp = bytes('UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQqOKVu/+BiOh/AAA=');

function crc(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length); result.write(name, 4, 'ascii'); Buffer.from(data).copy(result, 8);
  result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4);
  return result;
}
function png({ width = 1, height = 1, depth = 8, color = 0, interlace = 0, raw = [0, 127], compressed, before = [], after = [] } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = color; ihdr[12] = interlace;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...before, chunk('IDAT', compressed || deflateSync(Buffer.from(raw))), ...after, chunk('IEND')]));
}
function upload(file = new File(['hello'], 'notes.txt', { type: 'text/plain' }), fields = []) {
  const form = new FormData(); form.append('file', file);
  for (const [name, value] of fields) form.append(name, value);
  return new Request('https://prism.test/api/files', { method: 'POST', body: form });
}

test('multipart file reads are bounded, support chunked bodies, and preserve exact UTF-8 contents', async () => {
  const request = upload(new File(['안녕하세요\n<script>alert(1)</script>'], 'notes.html', { type: 'text/html' }));
  assert.equal(request.headers.get('content-length'), null);
  const file = await readSingleFileUpload(request, MAX_TEXT_UPLOAD_BYTES);
  const result = await validateTextUpload(file);
  assert.equal(result.name, 'notes.html');
  assert.equal(result.text, '안녕하세요\n<script>alert(1)</script>');
  assert.equal(result.size, Buffer.byteLength(result.text));
  assert.equal(untrustedContentHeaders['X-Content-Type-Options'], 'nosniff');
  assert.match(untrustedContentHeaders['Content-Security-Policy'], /sandbox/);
  assert.match(attachmentDisposition(result.name), /^attachment;/);
});

test('oversized bodies without Content-Length are cancelled before multipart parsing', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8192)); }, cancel() { cancelled = true; } });
  const request = new Request('https://prism.test/api/files', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=test' }, body, duplex: 'half' });
  await assert.rejects(readSingleFileUpload(request, 1000), error => error.status === 413);
  assert.equal(cancelled, true);
});

test('multipart rejects multiple fields, duplicate files, bad lengths, encodings, and interrupted input', async () => {
  for (const request of [upload(undefined, [['file', new File(['x'], 'other.txt')]]), upload(undefined, [['user_id', 'victim']])]) {
    await assert.rejects(readSingleFileUpload(request, MAX_TEXT_UPLOAD_BYTES), error => error.code === 'INVALID_UPLOAD');
  }
  for (const [header, value, status] of [['content-length', '0', 400], ['content-length', '-1', 400], ['content-length', '99999999', 413], ['content-encoding', 'gzip', 415]]) {
    const request = new Request('https://prism.test/api/files', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=test', [header]: value }, body: 'x' });
    await assert.rejects(readSingleFileUpload(request, MAX_TEXT_UPLOAD_BYTES), error => error.status === status);
  }
  const controller = new AbortController(); controller.abort();
  const request = new Request('https://prism.test/api/files', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=test' }, body: 'x', signal: controller.signal });
  await assert.rejects(readSingleFileUpload(request, MAX_TEXT_UPLOAD_BYTES), error => error.status === 408);
});

test('text uploads reject binary disguises, invalid UTF-8, dangerous filenames and oversized files', async () => {
  for (const file of [
    new File([new Uint8Array([0xc3, 0x28])], 'bad.txt'), new File(['hello\0world'], 'bad.txt'),
    new File(['hello'], 'bad.pdf'), new File(['hello'], 'notes.txt', { type: 'image/png' }),
    new File(['hello'], '../notes.txt'), new File(['hello'], 'note\u202etxt.exe.js'),
    new File([new Uint8Array(MAX_TEXT_UPLOAD_BYTES + 1)], 'large.txt'),
  ]) await assert.rejects(validateTextUpload(file), error => error.code === 'INVALID_UPLOAD');
  assert.equal(safeDownloadName('../../res\r\nult\u202e.csv'), 'result.csv');
  assert.doesNotMatch(attachmentDisposition('..\\file\r\nX-Evil:yes.html'), /\r|\n/);
  assert.doesNotThrow(() => attachmentDisposition('file\ud800.txt'));
  assert.doesNotThrow(() => attachmentDisposition('x'.repeat(149) + '😀.txt'));
  assert.equal(safeDownloadName('file😀.txt'), 'file😀.txt');
  assert.equal((await validateTextUpload(new File(['print("hello")'], 'source.py', { type: 'application/x-python-code' }))).text, 'print("hello")');
});

test('real PNG, baseline/progressive JPEG, and lossy/lossless WebP remain supported', async () => {
  assert.deepEqual(await validateReferenceImage(knownPng, 'image/png'), { width: 1, height: 1 });
  for (const [data, type] of [[jpeg, 'image/jpeg'], [progressiveJpeg, 'image/jpeg'], [webp, 'image/webp'], [losslessWebp, 'image/webp']]) {
    assert.deepEqual(await validateReferenceImage(data, type), { width: 2, height: 2 });
  }
  assert.deepEqual(await validateReferenceImage(png({ interlace: 1 }), 'image/png'), { width: 1, height: 1 });
  const adam7 = [];
  for (const [x, y, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
    const width = Math.max(0, Math.ceil((3 - x) / dx)), height = Math.max(0, Math.ceil((3 - y) / dy));
    if (width && height) for (let row = 0; row < height; row++) adam7.push(0, ...Array(width).fill(127));
  }
  assert.deepEqual(await validateReferenceImage(png({ width: 3, height: 3, interlace: 1, raw: adam7 }), 'image/png'), { width: 3, height: 3 });
});

test('containers reject truncated headers, missing endings, trailing payloads, and declared type mismatches', () => {
  for (const [data, type] of [[knownPng, 'image/png'], [jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
    for (const size of [1, 12, 25, 33, data.length - 1]) assert.throws(() => validateImageStructure(data.subarray(0, size), type), invalid);
    assert.throws(() => validateImageStructure(new Uint8Array([...data, ...Buffer.from('<script>alert(1)</script>')]), type), invalid);
    for (const wrong of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].filter(value => value !== type)) {
      assert.throws(() => validateImageStructure(data, wrong), invalid);
    }
  }
});

test('PNG checks all chunk CRCs, critical ordering, animation, and actual declared pixel limits', () => {
  const badCrc = knownPng.slice(); badCrc[badCrc.length - 8] ^= 1;
  for (const data of [badCrc, png({ width: 2049 }), png({ height: 2049 }), png({ depth: 3 }),
    png({ before: [chunk('acTL', Buffer.alloc(8))] }), png({ before: [chunk('BOOM', Buffer.from('payload'))] }),
    png({ after: [chunk('tEXt', Buffer.from('comment\0text')), chunk('IDAT', Buffer.from([0]))] }),
  ]) assert.throws(() => validateImageStructure(data, 'image/png'), invalid);
});

test('PNG rejects invalid zlib, truncated or excessive rasters, invalid filters and decompression bombs', async () => {
  const corrupted = deflateSync(Buffer.from([0, 123])); corrupted[corrupted.length - 1] ^= 1;
  for (const data of [png({ compressed: corrupted }), png({ raw: [0] }), png({ raw: [0, 1, 2] }), png({ raw: [5, 127] }), png({ raw: new Uint8Array(1_000_000) })]) {
    // Each fixture has valid container CRCs; rejection must inspect the complete compressed raster.
    assert.deepEqual(validateImageStructure(data, 'image/png'), { width: 1, height: 1 });
    await assert.rejects(validateReferenceImage(data, 'image/png'), invalid);
  }
});

test('indexed PNG validates reconstructed palette indexes across filtered rows', async () => {
  const palette = chunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0]));
  assert.deepEqual(await validateReferenceImage(png({ color: 3, height: 2, before: [palette], raw: [0, 1, 2, 0] }), 'image/png'), { width: 1, height: 2 });
  await assert.rejects(validateReferenceImage(png({ color: 3, before: [palette], raw: [0, 2] }), 'image/png'), invalid);
  await assert.rejects(validateReferenceImage(png({ color: 3, height: 2, before: [palette], raw: [0, 1, 2, 1] }), 'image/png'), invalid);
});

test('WebP validates RIFF/chunk lengths and both extended canvas and inner frame dimensions', () => {
  const badRiff = webp.slice(); badRiff[4] ^= 1;
  const badChunk = webp.slice(); badChunk[16] = 255;
  for (const data of [badRiff, badChunk]) assert.throws(() => validateImageStructure(data, 'image/webp'), invalid);
  const extended = Buffer.alloc(18); extended.write('VP8X'); extended.writeUInt32LE(10, 4); extended[12] = 2; extended[15] = 1;
  const withCanvas = Buffer.concat([Buffer.from(webp.subarray(0, 12)), extended, Buffer.from(webp.subarray(12))]); withCanvas.writeUInt32LE(withCanvas.length - 8, 4);
  assert.throws(() => validateImageStructure(withCanvas, 'image/webp'), invalid, 'canvas 3x2 must not mask a 2x2 frame');
  withCanvas[24] = 1; assert.deepEqual(validateImageStructure(withCanvas, 'image/webp'), { width: 2, height: 2 });
  withCanvas[20] = 2; assert.throws(() => validateImageStructure(withCanvas, 'image/webp'), invalid, 'animated references require a separately bounded decoder');
});

test('bounded malformed mutations always fail with a controlled validation error', () => {
  for (const [original, mime] of [[knownPng, 'image/png'], [jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
    for (let i = 0; i < original.length; i += 7) {
      const changed = original.slice(); changed[i] ^= 255;
      try { const accepted = validateImageStructure(changed, mime); assert.ok(accepted.width >= 1 && accepted.width <= 2048 && accepted.height >= 1 && accepted.height <= 2048); }
      catch (error) { assert.equal(error.code, 'INVALID_REFERENCE_IMAGE'); }
    }
  }
});
