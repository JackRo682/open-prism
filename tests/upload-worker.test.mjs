import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { imageFixtures } from './fixtures/upload-images.mjs';

const require = createRequire(await realpath(new URL('../node_modules/wrangler/package.json', import.meta.url)));
const { Miniflare } = await import(pathToFileURL(require.resolve('miniflare')).href);
const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);
const bundle = await build({
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
  stdin: { resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts', contents: `
    import { inspectImageStructure, validPngRaster } from './lib/upload-security.ts';
    export default { async fetch(request) {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const mime = request.headers.get('Content-Type');
      const dimensions = inspectImageStructure(bytes, mime);
      return Response.json({ dimensions, raster: mime === 'image/png' ? await validPngRaster(bytes, 2048) : null });
    } };
  ` },
});
const worker = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', script: bundle.outputFiles[0].text,
  outboundService: () => { throw new Error('Image checks must not contact any service.'); } });
after(() => worker.dispose());
const validate = async (body, mime = 'image/png') => (await worker.dispatchFetch('https://prism.test/image-fixture', {
  method: 'POST', body, headers: { 'Content-Type': mime },
})).json();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

test('native Workerd validates PNG raster streams and real JPEG/WebP containers without external decoding', async () => {
  assert.deepEqual(await validate(png), { dimensions: { width: 1, height: 1 }, raster: true });
  for (const [name, value] of Object.entries(imageFixtures)) {
    assert.deepEqual((await validate(Buffer.from(value, 'base64'), /jpeg/i.test(name) ? 'image/jpeg' : 'image/webp')).dimensions, { width: 2, height: 2 }, name);
  }
  const bad = Buffer.from(png); bad[45] ^= 1;
  assert.deepEqual(await validate(bad), { dimensions: null, raster: false });
});

test('native Workerd cancels compressed data that expands beyond the declared image', async () => {
  const compressed = deflateSync(Buffer.alloc(2 * 1024 * 1024));
  const idat = Buffer.alloc(12 + compressed.length);
  idat.writeUInt32BE(compressed.length); idat.write('IDAT', 4); compressed.copy(idat, 8);
  idat.writeUInt32BE(crc32(idat.subarray(4, -4)), idat.length - 4);
  const bomb = Buffer.concat([png.subarray(0, 33), idat, png.subarray(-12)]);
  assert.deepEqual(await validate(bomb), { dimensions: { width: 1, height: 1 }, raster: false });
});
