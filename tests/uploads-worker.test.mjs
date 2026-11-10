import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(await realpath(new URL('../node_modules/wrangler/package.json', import.meta.url)));
const { Miniflare } = await import(pathToFileURL(require.resolve('miniflare')).href);
const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);
const bundle = await build({
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', external: ['node:*'],
  stdin: {
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
    contents: `
      import { createTrackedAppRouteRequest } from './node_modules/vinext/dist/server/app-route-handler-runtime.js';
      import { boundedApiRequest } from './lib/request-security.ts';
      import { readSingleFileUpload, validateTextUpload, MAX_TEXT_UPLOAD_BYTES, attachmentDisposition, untrustedContentHeaders } from './lib/upload-validation.ts';
      import { validateReferenceImage } from './lib/image-validation.ts';
      export default { async fetch(input) {
        try {
          const request = await boundedApiRequest(createTrackedAppRouteRequest(input).request);
          const isImage = new URL(input.url).pathname === '/api/media/reference';
          const file = await readSingleFileUpload(request, isImage ? 4 * 1024 * 1024 : MAX_TEXT_UPLOAD_BYTES);
          if (isImage) {
            const result = await validateReferenceImage(new Uint8Array(await file.arrayBuffer()), file.type);
            return Response.json({ ...result, size: file.size });
          }
          const result = await validateTextUpload(file);
          return new Response(result.text, { headers: { ...untrustedContentHeaders, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': attachmentDisposition(result.name) } });
        } catch (error) { return Response.json({ error: error.message, code: error.code }, { status: error.status || 500 }); }
      } };
    `,
  },
});
const worker = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], script: bundle.outputFiles[0].text });
after(() => worker.dispose());
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
function send(body, { name = 'reference.png', mime = 'image/png', path = '/api/media/reference' } = {}) {
  const boundary = 'prism-upload-fixture';
  return worker.dispatchFetch('https://prism.test' + path, {
    method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body: Buffer.concat([Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + name + '"\r\nContent-Type: ' + mime + '\r\n\r\n'), Buffer.from(body), Buffer.from('\r\n--' + boundary + '--\r\n')]),
  });
}

test('Workerd decodes a complete PNG after real Vinext tracked multipart parsing', async () => {
  const response = await send(png);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { width: 1, height: 1, size: png.length });
});

test('Workerd rejects incomplete, mislabeled and bad-CRC images without provider requests', async () => {
  const crc = Buffer.from(png); crc[crc.length - 1] ^= 1;
  for (const [body, mime] of [[png.subarray(0, 33), 'image/png'], [crc, 'image/png'], [png, 'image/jpeg']]) {
    const response = await send(body, { mime });
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal((await response.json()).code, 'INVALID_REFERENCE_IMAGE');
  }
});

test('Workerd validates the PNG compressed raster even when every container CRC is valid', async () => {
  const corrupt = Buffer.from(png);
  const offset = 33, length = corrupt.readUInt32BE(offset), end = offset + 8 + length;
  corrupt[end - 1] ^= 1; // Corrupt zlib's Adler checksum, leaving pixel headers intact.
  let crc = 0xffffffff;
  for (const byte of corrupt.subarray(offset + 4, end)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  corrupt.writeUInt32BE((crc ^ 0xffffffff) >>> 0, end);
  const response = await send(corrupt);
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).code, 'INVALID_REFERENCE_IMAGE');
});

test('Workerd serves uploaded source as private plain-text attachments with sandbox protection', async () => {
  const text = '<script>alert("한글")</script>';
  const response = await send(text, { path: '/api/files', name: 'notes.html', mime: 'text/html' });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await response.text(), text);
  assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.match(response.headers.get('Content-Disposition'), /^attachment;/);
  assert.match(response.headers.get('Content-Security-Policy'), /sandbox/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});
