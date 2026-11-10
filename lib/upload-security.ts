/** Upload validation is deliberately independent of filenames and browser MIME claims.
 * JPEG/WebP checks below validate the complete container, not every compressed pixel.
 * Any future transcoding must still use an isolated, maintained image decoder. */
export const MAX_TEXT_FILE_BYTES = 128 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_PARTS = 4096;
const MAX_METADATA_BYTES = 256 * 1024;
const unsafeName = /[\\/\x00-\x1f\x7f-\x9f:\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const textExtension = /\.(txt|md|csv|json|ts|tsx|js|jsx|py|html|css|xml|yaml|yml|sql)$/i;

export function safeDownloadName(value: unknown, fallback = 'download.bin'): string {
  const name = (typeof value === 'string' ? value.split(/[\\/]/).pop()! : '')
    .replace(/[\x00-\x1f\x7f-\x9f:\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim();
  // Preserve the extension while capping names, including legacy provider filenames.
  const extension = /\.[a-zA-Z0-9]{1,12}$/.exec(name)?.[0] ?? '';
  const shortened = name.length > 150 ? name.slice(0, 150 - extension.length) + extension : name;
  // Re-encode to replace lone UTF-16 surrogates before encodeURIComponent below.
  return shortened && shortened !== '.' && shortened !== '..'
    ? new TextDecoder().decode(new TextEncoder().encode(shortened)) : fallback;
}

export function attachmentDisposition(name: unknown): string {
  return "attachment; filename*=UTF-8''" + encodeURIComponent(safeDownloadName(name))
    .replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

export const PRIVATE_FILE_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox; base-uri 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer',
};

export function isOwnedObjectKey(value: unknown, owner: string, namespace?: 'media' | 'references' | 'artifacts'): value is string {
  if (typeof value !== 'string' || !owner || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) return false;
  const prefix = owner + '/' + (namespace ? namespace + '/' : '');
  return value.startsWith(prefix) && value.length > prefix.length
    && value.slice(prefix.length).split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function readTextUpload(bytes: Uint8Array, name: string): string | null {
  if (!bytes.byteLength || bytes.byteLength > MAX_TEXT_FILE_BYTES || name.length > 200
    || unsafeName.test(name) || !textExtension.test(name)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ? null : text;
  } catch { return null; }
}

export function validReferenceName(name: string, mime: string): boolean {
  if (!name || name.length > 200 || unsafeName.test(name)) return false;
  return mime === 'image/png' ? /\.png$/i.test(name)
    : mime === 'image/jpeg' ? /\.jpe?g$/i.test(name)
      : mime === 'image/webp' && /\.webp$/i.test(name);
}

type Dimensions = { width: number; height: number };
type PngInfo = Dimensions & { depth: number; channels: number; interlaced: boolean; data: Uint8Array[] };
const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngInfo(bytes: Uint8Array): PngInfo | null {
  if (bytes.length < 57 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, parts = 0, metadata = 0, color = -1, palette = false, endedData = false, dataSize = 0;
  let info: PngInfo | undefined;
  const seen = new Set<string>();
  while (offset + 12 <= bytes.length && ++parts <= MAX_IMAGE_PARTS) {
    const size = view.getUint32(offset), type = ascii(bytes, offset + 4, 4), end = offset + 12 + size;
    if (end > bytes.length || !/^[a-zA-Z]{2}[A-Z][a-zA-Z]$/.test(type)
      || crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) return null;
    if (!info && type !== 'IHDR') return null;
    if (type === 'IHDR') {
      if (info || size !== 13) return null;
      const width = view.getUint32(offset + 8), height = view.getUint32(offset + 12), depth = bytes[offset + 16];
      color = bytes[offset + 17];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[color]?.includes(depth)
        || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return null;
      info = { width, height, depth, channels: ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color], interlaced: bytes[offset + 20] === 1, data: [] };
    } else if (type === 'IDAT') {
      if (endedData || color === 3 && !palette) return null;
      dataSize += size;
      info!.data.push(bytes.subarray(offset + 8, end - 4));
    } else {
      if (info!.data.length) endedData = true;
      if (type === 'IEND') return size === 0 && end === bytes.length && dataSize >= 6 ? info! : null;
      if (type === 'PLTE') {
        if (palette || info!.data.length || !size || size > 768 || size % 3 || [0, 4].includes(color)
          || color === 3 && size / 3 > 2 ** info!.depth) return null;
        palette = true;
      } else if (type === 'tRNS') {
        if (seen.has(type) || info!.data.length || (color === 0 ? size !== 2 : color === 2 ? size !== 6 : color === 3 ? !palette || !size || size > 256 : true)) return null;
      } else if (['acTL', 'fcTL', 'fdAT'].includes(type) || type[0] === type[0].toUpperCase()) return null;
      metadata += size;
      if (metadata > MAX_METADATA_BYTES) return null;
    }
    seen.add(type);
    offset = end;
  }
  return null;
}

function jpegInfo(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2, parts = 0, scans = 0, metadata = 0, quantization = false, huffman = false;
  let dimensions: Dimensions | undefined, frameMarker = 0;
  const components = new Set<number>();
  while (offset < bytes.length && ++parts <= MAX_IMAGE_PARTS) {
    if (bytes[offset++] !== 255) return null;
    while (offset < bytes.length && bytes[offset] === 255) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 217) return offset === bytes.length && scans > 0 && quantization && huffman ? dimensions ?? null : null;
    if (marker === 0 || marker === 216 || marker === 1 || marker >= 208 && marker <= 215 || offset + 2 > bytes.length) return null;
    const length = view.getUint16(offset), end = offset + length;
    if (length < 2 || end > bytes.length) return null;
    if ([192, 193, 194].includes(marker)) {
      if (dimensions || length < 8 || bytes[offset + 2] !== 8) return null;
      const count = bytes[offset + 7], height = view.getUint16(offset + 3), width = view.getUint16(offset + 5);
      if (![1, 3, 4].includes(count) || length !== 8 + 3 * count || !width || !height) return null;
      let sampling = 0;
      for (let index = 0; index < count; index++) {
        const start = offset + 8 + index * 3, id = bytes[start], h = bytes[start + 1] >> 4, v = bytes[start + 1] & 15;
        if (components.has(id) || h < 1 || h > 4 || v < 1 || v > 4 || bytes[start + 2] > 3) return null;
        components.add(id); sampling += h * v;
      }
      if (sampling > 10) return null;
      dimensions = { width, height }; frameMarker = marker;
    } else if (marker === 219) {
      let cursor = offset + 2;
      while (cursor < end) {
        const precision = bytes[cursor] >> 4, id = bytes[cursor] & 15;
        if (precision > 1 || id > 3) return null;
        cursor += 1 + 64 * (precision + 1);
      }
      if (cursor !== end || length === 2) return null;
      quantization = true;
    } else if (marker === 196) {
      let cursor = offset + 2;
      while (cursor < end) {
        if (cursor + 17 > end || bytes[cursor] >> 4 > 1 || (bytes[cursor] & 15) > 3) return null;
        let symbols = 0;
        for (let index = 1; index <= 16; index++) symbols += bytes[cursor + index];
        if (!symbols || symbols > 256) return null;
        cursor += 17 + symbols;
      }
      if (cursor !== end || length === 2) return null;
      huffman = true;
    } else if (marker === 218) {
      if (!dimensions || !quantization || !huffman || ++scans > 64 || length < 6) return null;
      const count = bytes[offset + 2], selected = new Set<number>();
      if (count < 1 || count > components.size || length !== 6 + 2 * count) return null;
      for (let index = 0; index < count; index++) {
        const id = bytes[offset + 3 + index * 2], tables = bytes[offset + 4 + index * 2];
        if (!components.has(id) || selected.has(id) || tables >> 4 > 3 || (tables & 15) > 3) return null;
        selected.add(id);
      }
      const start = bytes[end - 3], finish = bytes[end - 2], approximation = bytes[end - 1];
      if (frameMarker !== 194 ? start !== 0 || finish !== 63 || approximation !== 0
        : start > finish || finish > 63 || approximation >> 4 > 13 || (approximation & 15) > 13 || count > 1 && (start !== 0 || finish !== 0)) return null;
      offset = end;
      let entropy = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; entropy++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || next >= 208 && next <= 215) { offset += 2; entropy++; continue; }
        if (next === 255) { offset++; continue; }
        break;
      }
      if (!entropy) return null;
      continue;
    } else if (marker === 221) {
      if (length !== 4) return null;
    } else if (marker >= 224 && marker <= 239 || marker === 254) {
      metadata += length - 2;
      if (metadata > MAX_METADATA_BYTES) return null;
    } else return null;
    offset = end;
  }
  return null;
}

function webpInfo(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 26 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length || bytes.length % 2) return null;
  let offset = 12, parts = 0, flags = 0, metadata = 0, alpha = false;
  let canvas: Dimensions | undefined, image: Dimensions | undefined;
  const seen = new Set<string>();
  while (offset + 8 <= bytes.length && ++parts <= MAX_IMAGE_PARTS) {
    const type = ascii(bytes, offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8, end = start + size;
    const next = end + (size % 2);
    if (!/^[\x20-\x7e]{4}$/.test(type) || next > bytes.length || size % 2 && bytes[end] !== 0) return null;
    if (parts === 1 && !['VP8X', 'VP8 ', 'VP8L'].includes(type)) return null;
    if (['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ICCP', 'EXIF', 'XMP '].includes(type) && seen.has(type)) return null;
    if (type === 'VP8X') {
      if (parts !== 1 || size !== 10 || bytes[start] & 0xc3 || bytes[start + 1] || bytes[start + 2] || bytes[start + 3]) return null;
      flags = bytes[start];
      canvas = { width: 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16), height: 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16) };
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (image) return null;
      if (type === 'VP8 ') {
        if (size <= 10 || bytes[start] & 1 || ((bytes[start] >> 1) & 7) > 3 || !(bytes[start] & 16)
          || bytes[start + 3] !== 157 || bytes[start + 4] !== 1 || bytes[start + 5] !== 42) return null;
        const partition = (bytes[start] + (bytes[start + 1] << 8) + (bytes[start + 2] << 16)) >>> 5;
        if (!partition || partition > size - 10) return null;
        image = { width: view.getUint16(start + 6, true) & 16383, height: view.getUint16(start + 8, true) & 16383 };
      } else {
        if (size <= 5 || bytes[start] !== 47 || bytes[start + 4] & 0xe0 || seen.has('ALPH')) return null;
        image = { width: 1 + bytes[start + 1] + ((bytes[start + 2] & 63) << 8), height: 1 + (bytes[start + 2] >> 6) + (bytes[start + 3] << 2) + ((bytes[start + 4] & 15) << 10) };
        alpha = !!(bytes[start + 4] & 16);
      }
      if (!image.width || !image.height || canvas && (image.width !== canvas.width || image.height !== canvas.height)) return null;
    } else if (type === 'ALPH') {
      if (!canvas || image || !(flags & 16) || size < 2 || bytes[start] & 0xc0
        || (bytes[start] & 3) > 1 || ((bytes[start] >> 4) & 3) > 1
        || (bytes[start] & 3) === 0 && size !== 1 + canvas.width * canvas.height) return null;
      alpha = true;
    } else {
      if (type === 'ANIM' || type === 'ANMF' || !canvas
        || type === 'ICCP' && (image || !(flags & 32))
        || type === 'EXIF' && (!image || !(flags & 8))
        || type === 'XMP ' && (!image || !(flags & 4))) return null;
      metadata += size;
      if (metadata > MAX_METADATA_BYTES) return null;
    }
    seen.add(type); offset = next;
  }
  if (offset !== bytes.length || !image || canvas && (!!(flags & 32) !== seen.has('ICCP')
    || !!(flags & 8) !== seen.has('EXIF') || !!(flags & 4) !== seen.has('XMP ') || !!(flags & 16) !== alpha)) return null;
  return image;
}

export function inspectImageStructure(bytes: Uint8Array, mime: string): Dimensions | null {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) return null;
  const info = mime === 'image/png' ? pngInfo(bytes) : mime === 'image/jpeg' ? jpegInfo(bytes) : mime === 'image/webp' ? webpInfo(bytes) : null;
  return info ? { width: info.width, height: info.height } : null;
}

/** Fully consume PNG's zlib raster stream with an exact scanline budget. This
 * catches truncated/invalid deflate, forged dimensions and decompression bombs
 * without retaining decoded pixels. JPEG/WebP still require external decoders. */
export async function validPngRaster(bytes: Uint8Array, maxDimension: number): Promise<boolean> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IMAGE_BYTES
    || !Number.isSafeInteger(maxDimension) || maxDimension < 1 || maxDimension > 4096) return false;
  const info = pngInfo(bytes);
  if (!info || info.width > maxDimension || info.height > maxDimension) return false;
  const passes = info.interlaced ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows: number[] = [];
  for (const [x, y, dx, dy] of passes) {
    const width = Math.max(0, Math.ceil((info.width - x) / dx)), height = Math.max(0, Math.ceil((info.height - y) / dy));
    if (width) for (let row = 0; row < height; row++) rows.push(1 + Math.ceil(width * info.depth * info.channels / 8));
  }
  let part = 0, offset = 0;
  const source = new ReadableStream<BufferSource>({ pull(controller) {
    while (part < info.data.length && offset === info.data[part].length) { part++; offset = 0; }
    if (part === info.data.length) { controller.close(); return; }
    // Small input chunks also bound expansion within the native decoder.
    const end = Math.min(offset + 1024, info.data[part].length);
    const chunk = new Uint8Array(end - offset);
    chunk.set(info.data[part].subarray(offset, end));
    controller.enqueue(chunk); offset = end;
  } });
  const reader = source.pipeThrough(new DecompressionStream('deflate')).getReader();
  let row = 0, column = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return row === rows.length && column === 0;
      let at = 0;
      while (at < value.length) {
        if (row >= rows.length || column === 0 && value[at] > 4) { void reader.cancel().catch(() => {}); return false; }
        const take = Math.min(rows[row] - column, value.length - at);
        column += take; at += take;
        if (column === rows[row]) { row++; column = 0; }
      }
    }
  } catch { return false; }
  finally { reader.releaseLock(); }
}
