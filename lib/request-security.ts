export class RequestSecurityError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

export function apiBodyLimit(request: Request): number {
  const path = new URL(request.url).pathname;
  if (request.method === 'POST' && path === '/api/media/reference') return 4 * 1024 * 1024 + 16384;
  if (request.method === 'PATCH' && path === '/api/settings') return 600000;
  if (request.method === 'POST' && path === '/api/guest/chat') return 80000;
  if (request.method === 'POST' && path === '/api/chat') return 100000;
  if (request.method === 'POST' && path === '/api/files') return 150000;
  return 200000;
}

/** Read the original stream once. Request.clone() tees and buffers its unread
 * branch, which defeats cancellation of an oversized or stalled upload. */
export async function boundedApiRequest(request: Request, timeoutMs = 30000): Promise<Request> {
  if (request.signal.aborted) throw new RequestSecurityError('Request was cancelled.', 408, 'REQUEST_ABORTED');
  if (!request.body || request.method === 'GET' || request.method === 'HEAD') return request;

  const limit = apiBodyLimit(request);
  const declared = request.headers.get('content-length');
  const rejectBody = (error: RequestSecurityError): never => {
    void request.body?.cancel().catch(() => {});
    throw error;
  };
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    rejectBody(new RequestSecurityError('Invalid request length.', 400, 'INVALID_CONTENT_LENGTH'));
  }
  if (declared !== null && Number(declared) > limit) {
    rejectBody(new RequestSecurityError('Request is too large.', 413, 'REQUEST_TOO_LARGE'));
  }
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    rejectBody(new RequestSecurityError('Encoded request bodies are not supported.', 415, 'UNSUPPORTED_CONTENT_ENCODING'));
  }
  const path = new URL(request.url).pathname;
  const multipart = request.method === 'POST' && (path === '/api/files' || path === '/api/media/reference');
  const contentType = request.headers.get('content-type') || '';
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  if (multipart ? mediaType !== 'multipart/form-data' : mediaType !== 'application/json') {
    rejectBody(new RequestSecurityError(multipart ? 'Choose a file to upload.' : 'Send a JSON request.', 415, 'UNSUPPORTED_CONTENT_TYPE'));
  }
  const charsets = [...contentType.matchAll(/;\s*charset\s*=\s*(?:"([^"]*)"|([^;]*))/gi)];
  if (!multipart && charsets.some(match => (match[1] ?? match[2]).trim().toLowerCase() !== 'utf-8')) {
    rejectBody(new RequestSecurityError('JSON requests must use UTF-8.', 415, 'UNSUPPORTED_CHARSET'));
  }

  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  let stop!: (error: RequestSecurityError) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { stop = reject; });
  const cancel = (error: RequestSecurityError) => {
    stop(error);
    void reader.cancel().catch(() => {});
  };
  const onAbort = () => cancel(new RequestSecurityError('Request was cancelled.', 408, 'REQUEST_ABORTED'));
  request.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => cancel(new RequestSecurityError('Request upload timed out.', 408, 'REQUEST_TIMEOUT')), timeoutMs);
  let stage: 'read' | 'copy' | 'decode' | 'metadata' | 'cf' | 'construct' = 'read';
  try {
    if (request.signal.aborted) onAbort();
    while (true) {
      const part = await Promise.race([reader.read(), interrupted]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new RequestSecurityError('Request is too large.', 413, 'REQUEST_TOO_LARGE');
      chunks.push(part.value);
    }
    if (request.signal.aborted) throw new RequestSecurityError('Request was cancelled.', 408, 'REQUEST_ABORTED');
    stage = 'copy';
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    stage = 'decode';
    if (!multipart) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new RequestSecurityError('JSON requests must use valid UTF-8.', 400, 'INVALID_UTF8'); }
    }
    // Vinext wraps route requests in a tracking Proxy. Workerd cannot recognize
    // that proxy as a native Request and stringifies it as "[object Request]".
    // Rebuild from its URL after checking the original stream, preserving the
    // trusted identity/edge metadata and cancellation without cloning the body.
    stage = 'metadata';
    const init: RequestInit = {
      method: request.method, headers: request.headers, body: bytes,
      redirect: request.redirect, signal: request.signal,
    };
    stage = 'construct';
    const bounded = new Request(request.url, init);
    stage = 'cf';
    // Hosted framework wrappers can expose cf through an accessor that throws.
    // The API does not need this optional metadata to validate/read a body.
    // Preserve its original access semantics lazily: never evaluate it here or
    // interpret incoming metadata as outbound RequestInit.cf configuration.
    Object.defineProperty(bounded, 'cf', {
      get: () => (request as Request & { cf?: unknown }).cf, enumerable: true, configurable: true,
    });
    return bounded;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof RequestSecurityError) throw error;
    // Fixed labels only: never log exception messages, URLs, headers, or bodies.
    const exceptionType = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError'
      : error instanceof DOMException ? 'DOMException' : error instanceof Error ? 'Error' : 'Unknown';
    console.warn(JSON.stringify({ event: 'api_request_body_failure', stage, exceptionType }));
    throw new RequestSecurityError('The request body could not be read.', 400, 'INVALID_REQUEST_BODY');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** One stable row per account bounds write churn without accumulating rows per
 * time window. SQLite evaluates the quota and update atomically across workers. */
export async function allowAccountMutation(sql: D1Database, owner: string, now = Date.now()): Promise<boolean> {
  const row = await sql.prepare(`INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
      expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at<=? OR count<120 RETURNING key`)
    .bind(owner + ':api-write', now + 60000, now, now, now).first();
  return !!row;
}
