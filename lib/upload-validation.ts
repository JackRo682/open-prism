import { WorkspaceToolError } from './workspace-tools';
import { MAX_TEXT_FILE_BYTES, readTextUpload, validUploadName, safeDownloadName, attachmentDisposition, PRIVATE_FILE_HEADERS } from './upload-security';

export const MAX_TEXT_UPLOAD_BYTES = MAX_TEXT_FILE_BYTES;
export { safeDownloadName, attachmentDisposition };
export const untrustedContentHeaders = PRIVATE_FILE_HEADERS;
const MULTIPART_OVERHEAD_BYTES = 16 * 1024;
const invalid = (message: string, status = 400) => new WorkspaceToolError(message, status, 'INVALID_UPLOAD');

/** Bound the actual stream before invoking the multipart parser, even without Content-Length. */
export async function readSingleFileUpload(request: Request, maxFileBytes: number): Promise<File> {
  const type = request.headers.get('content-type') || '';
  const boundary = /^multipart\/form-data\s*;\s*boundary=(?:"([\x20-\x7e]{1,70})"|([!#$%&'*+.^_`|~0-9A-Za-z-]{1,70}))\s*$/i.exec(type);
  if (!boundary || /[\r\n]/.test(type)) throw invalid('Choose a file using multipart form data.');
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') throw invalid('Compressed upload requests are not supported.', 415);
  const limit = maxFileBytes + MULTIPART_OVERHEAD_BYTES;
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw invalid('Invalid upload length.');
  if (length !== null && Number(length) > limit) {
    await request.body?.cancel().catch(() => {});
    throw invalid('The upload exceeds the file size limit.', 413);
  }
  if (!request.body) throw invalid('Choose a file.');
  // A single bounded buffer also prevents many one-byte chunks growing an unbounded chunk list.
  const bytes = new Uint8Array(limit), reader = request.body.getReader();
  const timeout = AbortSignal.timeout(15_000), signal = AbortSignal.any([request.signal, timeout]);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let used = 0;
  try {
    if (signal.aborted) throw invalid('The upload was interrupted.', 408);
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw invalid('The upload was interrupted.', 408);
      if (done) break;
      if (used + value.byteLength > limit) {
        await reader.cancel().catch(() => {});
        throw invalid('The upload exceeds the file size limit.', 413);
      }
      bytes.set(value, used); used += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof WorkspaceToolError) throw error;
    throw invalid('The upload could not be read.');
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  if (length !== null && Number(length) !== used) throw invalid('The upload was incomplete.');
  let form: FormData;
  try { form = await new Response(bytes.subarray(0, used), { headers: { 'Content-Type': type } }).formData(); }
  catch { throw invalid('The upload form is malformed.'); }
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0][0] !== 'file' || !(entries[0][1] instanceof File)) throw invalid('Upload exactly one file.');
  const file = entries[0][1];
  if (file.size > maxFileBytes) throw invalid('The upload exceeds the file size limit.', 413);
  validateUploadName(file.name);
  return file;
}

export function validateUploadName(name: string): void {
  if (!validUploadName(name)) {
    throw invalid('Choose a file with a plain filename.');
  }
}

export async function validateTextUpload(file: File): Promise<{ name: string; text: string; size: number }> {
  validateUploadName(file.name);
  if (!file.size || file.size > MAX_TEXT_UPLOAD_BYTES || !/\.(txt|md|csv|json|ts|tsx|js|jsx|py|html|css|xml|yaml|yml|sql)$/i.test(file.name)) {
    throw invalid('Upload text, Markdown, CSV, JSON, or source code up to 128 KB.');
  }
  const mime = file.type.split(';')[0].toLowerCase();
  if (mime && mime !== 'application/octet-stream' && !/^text\/[a-z0-9.+-]+$/.test(mime)
      && !/^application\/(?:json|ld\+json|javascript|x-javascript|ecmascript|typescript|x-python|x-python-code|xml|xhtml\+xml|yaml|x-yaml|sql|x-sql|csv|vnd\.ms-excel)$/.test(mime)) {
    throw invalid('Only plain text files are supported.');
  }
  let text: string | null;
  try { text = readTextUpload(new Uint8Array(await file.arrayBuffer()), file.name); }
  catch { throw invalid('Save the file as UTF-8 text before uploading.'); }
  if (text === null) throw invalid('Only valid UTF-8 plain text files are supported.');
  return { name: safeDownloadName(file.name, 'document.txt'), text, size: new TextEncoder().encode(text).byteLength };
}
