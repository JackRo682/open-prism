import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const output = fileURLToPath(new URL('../public/fonts/prism-export-cjk-v1.ttf', import.meta.url));
const packed = new URL('../assets/fonts/prism-export-cjk-v1.ttf.br', import.meta.url);
const expectedBytes = 19_974_876;
const expectedHash = '2a7f1dd1c04378cd76c9cad16c11003bdbb105969b2460ddc1d430f04a911b84';
const valid = bytes => bytes.length === expectedBytes && createHash('sha256').update(bytes).digest('hex') === expectedHash;

/** The repository stores a lossless packed copy; the served font stays byte-identical. */
export function ensureExportFont() {
  if (existsSync(output) && valid(readFileSync(output))) return output;
  const bytes = brotliDecompressSync(readFileSync(packed), { maxOutputLength: expectedBytes });
  if (!valid(bytes)) throw new Error('The bundled CJK export font failed its integrity check.');
  mkdirSync(dirname(output), { recursive: true });
  const temporary = output + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o644 });
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ensureExportFont();
