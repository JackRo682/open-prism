import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { deflateSync, crc32 } from 'node:zlib';
import ts from 'typescript';
import { imageFixtures } from './fixtures/upload-images.mjs';

const directory = new URL('../.sites-runtime/upload-security-tests/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('upload-security.mjs', directory), ts.transpileModule(
  await readFile(new URL('../lib/upload-security.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText);
const { inspectImageStructure, validPngRaster, readTextUpload, safeDownloadName,
  attachmentDisposition, validReferenceName, isOwnedObjectKey } = await import(new URL('upload-security.mjs', directory));
const bytes = value => new Uint8Array(Buffer.from(value, 'base64'));
const png = bytes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=');
const encoder = new TextEncoder();
function chunk(type, data) {
  const header = Buffer.alloc(8), trailer = Buffer.alloc(4);
  header.writeUInt32BE(data.length); header.write(type, 4, 4, 'ascii');
  trailer.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
  return Buffer.concat([header, data, trailer]);
}
function makePng({ width = 1, height = 1, raw = Buffer.from([0, 10, 20, 30]), compressed, extra = [], interlaced = false } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2; header[12] = Number(interlaced);
  return new Uint8Array(Buffer.concat([Buffer.from(png.subarray(0, 8)), chunk('IHDR', header), ...extra,
    chunk('IDAT', compressed ?? deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

test('real PNG, baseline/progressive JPEG and lossy/lossless/alpha WebP survive complete-container validation', async () => {
  assert.deepEqual(inspectImageStructure(png, 'image/png'), { width: 1, height: 1 });
  assert.equal(await validPngRaster(png, 2048), true);
  for (const [name, fixture] of Object.entries(imageFixtures)) {
    assert.deepEqual(inspectImageStructure(bytes(fixture), /jpeg/i.test(name) ? 'image/jpeg' : 'image/webp'), { width: 2, height: 2 }, name);
  }
  assert.equal(await validPngRaster(makePng({ interlaced: true }), 2048), true);
});

test('mismatched declarations, header-only images, truncation, appended payloads, and oversized image input fail', () => {
  for (const [image, mime] of [[png, 'image/png'], [bytes(imageFixtures.jpeg), 'image/jpeg'], [bytes(imageFixtures.webp), 'image/webp']]) {
    assert.equal(inspectImageStructure(image, mime === 'image/png' ? 'image/jpeg' : 'image/png'), null);
    assert.equal(inspectImageStructure(image.subarray(0, 33), mime), null);
    assert.equal(inspectImageStructure(image.subarray(0, image.length - 1), mime), null);
    assert.equal(inspectImageStructure(new Uint8Array(Buffer.concat([image, Buffer.from('<script>payload</script>')])), mime), null);
  }
  assert.equal(inspectImageStructure(new Uint8Array(16 * 1024 * 1024 + 1), 'image/png'), null);
  assert.equal(inspectImageStructure(encoder.encode('<svg onload="alert(1)"/>'), 'image/svg+xml'), null);
});

test('PNG validates CRCs, critical chunks, static-only policy, chunk counts and bounded metadata', () => {
  const badCrc = png.slice(); badCrc[45] ^= 1;
  assert.equal(inspectImageStructure(badCrc, 'image/png'), null);
  for (const extra of [
    [chunk('acTL', Buffer.alloc(8))], [chunk('ABCD', Buffer.alloc(0))],
    [chunk('tEXt', Buffer.alloc(256 * 1024 + 1))],
    Array.from({ length: 4096 }, () => chunk('tEXt', Buffer.alloc(0))),
  ]) assert.equal(inspectImageStructure(makePng({ extra }), 'image/png'), null);
  const overflow = makePng(); new DataView(overflow.buffer).setUint32(33, 0xffffffff);
  assert.equal(inspectImageStructure(overflow, 'image/png'), null);
});

test('every truncated prefix of genuine image fixtures fails closed without parser exceptions', () => {
  for (const [image, mime] of [[png, 'image/png'], ...Object.entries(imageFixtures).map(([name, value]) => [bytes(value), /jpeg/i.test(name) ? 'image/jpeg' : 'image/webp'])]) {
    for (let size = 0; size < image.length; size++) assert.equal(inspectImageStructure(image.subarray(0, size), mime), null, mime + ' at ' + size);
  }
});

test('PNG compressed pixels must exactly fit their declared scanlines and filter bytes', async () => {
  for (const raw of [Buffer.alloc(0), Buffer.alloc(3), Buffer.from([5, 10, 20, 30]), Buffer.alloc(5), Buffer.alloc(2 * 1024 * 1024)]) {
    const value = makePng({ raw });
    assert.ok(inspectImageStructure(value, 'image/png'), 'fixture has a valid container');
    assert.equal(await validPngRaster(value, 2048), false);
  }
  const checksum = deflateSync(Buffer.from([0, 10, 20, 30])); checksum[checksum.length - 1] ^= 1;
  assert.equal(await validPngRaster(makePng({ compressed: checksum }), 2048), false, 'zlib checksum verified even when PNG CRC is valid');
  assert.equal(await validPngRaster(makePng({ compressed: Buffer.from([0, 1, 2, 3, 4, 5]) }), 2048), false);
  assert.equal(await validPngRaster(makePng({ width: 2049 }), 2048), false);
  assert.equal(await validPngRaster(makePng({ height: 2049 }), 2048), false);
});

test('WebP rejects inconsistent RIFF size, animation, frame-less VP8X, and conflicting canvas dimensions', () => {
  const declared = bytes(imageFixtures.webp); new DataView(declared.buffer).setUint32(4, declared.length - 9, true);
  assert.equal(inspectImageStructure(declared, 'image/webp'), null);
  const animated = bytes(imageFixtures.alphaWebp); animated[20] |= 2;
  assert.equal(inspectImageStructure(animated, 'image/webp'), null);
  const canvas = bytes(imageFixtures.alphaWebp); canvas[24] = 2;
  assert.equal(inspectImageStructure(canvas, 'image/webp'), null);
  const empty = bytes(imageFixtures.alphaWebp).slice(0, 30); new DataView(empty.buffer).setUint32(4, 22, true);
  assert.equal(inspectImageStructure(empty, 'image/webp'), null);
});

test('text uploads require supported plain names and strict UTF-8, rejecting binary controls and oversized files', () => {
  const value = '한글 <script>alert(1)</script>\nconst x = 1;\t';
  assert.equal(readTextUpload(encoder.encode(value), 'notes.ts'), value, 'source text remains data and must be downloaded safely');
  for (const payload of [new Uint8Array([0xc3, 0x28]), new Uint8Array([0xff]), encoder.encode('a\x00b'), encoder.encode('a\x1bb'), new Uint8Array(), new Uint8Array(131073)]) {
    assert.equal(readTextUpload(payload, 'notes.txt'), null);
  }
  for (const name of ['notes.pdf', 'notes.txt.exe', '../notes.txt', 'C:\\notes.txt', 'notes:stream.txt', 'notes\r\nHeader.txt', 'fake\u202Etxt.exe.txt']) {
    assert.equal(readTextUpload(encoder.encode('ordinary text'), name), null, name);
  }
  assert.equal(validReferenceName('picture.PNG', 'image/png'), true);
  assert.equal(validReferenceName('picture.jpeg', 'image/jpeg'), true);
  assert.equal(validReferenceName('picture.png', 'image/jpeg'), false);
  assert.equal(validReferenceName('picture.svg', 'image/png'), false);
});

test('download names cannot inject headers or paths and preserve safe Unicode and extensions', () => {
  assert.equal(safeDownloadName('../../report\r\n.html'), 'report.html');
  assert.equal(safeDownloadName('a'.repeat(200) + '.txt').length, 150);
  assert.match(safeDownloadName('a'.repeat(200) + '.txt'), /\.txt$/);
  const value = attachmentDisposition('한글\r\nInjected: yes\u202E.txt');
  assert.match(value, /^attachment; filename\*=UTF-8''/);
  assert.doesNotMatch(value, /\r|\n|Injected:|%0[AD]/i);
  assert.doesNotThrow(() => attachmentDisposition('\ud800.txt'));
});

test('stored keys require the exact account prefix and correct media namespace', () => {
  assert.equal(isOwnedObjectKey('alice/file-id', 'alice'), true);
  assert.equal(isOwnedObjectKey('alice/media/id/version', 'alice', 'media'), true);
  for (const key of ['bob/file-id', 'alice2/file-id', 'alice/', 'alice/../bob/file-id', 'alice//file-id', 'alice/file\x00']) {
    assert.equal(isOwnedObjectKey(key, 'alice'), false, key);
  }
  assert.equal(isOwnedObjectKey('alice/artifacts/id', 'alice', 'references'), false);
});
