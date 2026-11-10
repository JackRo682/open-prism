/** Browser-only Google Drive access. Tokens never enter application API requests. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const MAX_DRIVE_FILE_BYTES = 131072;
export const MAX_DRIVE_SESSION_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_MARGIN_MS = 30000;
const MAX_METADATA_BYTES = 16384;

export type DriveTokenResponse = {
  access_token?: string; expires_in?: number | string; error?: string; scope?: string; token_type?: string;
};

const googleExports = new Map([
  ['application/vnd.google-apps.document', { mime: 'text/plain', extension: 'txt' }],
  ['application/vnd.google-apps.spreadsheet', { mime: 'text/csv', extension: 'csv' }],
  ['application/vnd.google-apps.presentation', { mime: 'text/plain', extension: 'txt' }],
]);
export const DRIVE_SELECTABLE_MIME_TYPES = [
  ...googleExports.keys(), 'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css',
  'text/javascript', 'text/xml', 'application/json', 'application/xml', 'application/javascript',
];

/** Drop the SDK response's reference, including rejected or stale callbacks. */
export function clearDriveTokenResponse(response: DriveTokenResponse): void {
  // The SDK owns this object. A frozen SDK response must not interrupt cleanup.
  try { response.access_token = undefined; } catch { /* No application reference is retained. */ }
}

function driveRequestUrl(value: string, method: string): string {
  const url = new URL(value);
  if (url.origin !== 'https://www.googleapis.com' || url.username || url.password || url.hash) {
    throw new Error('허용되지 않은 Google Drive 요청입니다.');
  }
  const read = method === 'GET' && /^\/drive\/v3\/files\/[A-Za-z0-9_-]{1,256}(?:\/export)?$/.test(url.pathname);
  const write = method === 'POST' && url.pathname === '/upload/drive/v3/files';
  const allowedParameters = new Set(['fields', 'supportsAllDrives', 'alt', 'mimeType', 'uploadType']);
  if ((!read && !write) || [...url.searchParams.keys()].some(name => !allowedParameters.has(name))) {
    throw new Error('허용되지 않은 Google Drive 요청입니다.');
  }
  return url.href;
}

/** One explicit user action, with no token reuse across picker openings. */
export class DriveAccessSession {
  readonly #controller = new AbortController();
  readonly signal = this.#controller.signal;
  #phase: 'authorizing' | 'authorized' | 'transferring' | 'released' | 'cancelled' = 'authorizing';
  #token: string | null = null;
  #expiresAt = Date.now() + MAX_DRIVE_SESSION_MS;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor() { this.armDeadline(this.#expiresAt); }

  get awaitingAuthorization(): boolean { return this.#phase === 'authorizing' && !this.signal.aborted; }
  get transferInProgress(): boolean { return this.#phase === 'transferring' && !this.signal.aborted; }

  private armDeadline(deadline: number): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.cancel(new DOMException('Google 연결 시간이 초과되었습니다. 다시 연결해 주세요.', 'TimeoutError')), Math.max(0, deadline - Date.now()));
  }

  /** False means a duplicate or late callback; it must not replace an active token. */
  acceptToken(response: DriveTokenResponse): boolean {
    if (!this.awaitingAuthorization) return false;
    if (Date.now() >= this.#expiresAt) {
      this.cancel(new DOMException('Google 연결 시간이 초과되었습니다. 다시 연결해 주세요.', 'TimeoutError'));
      return false;
    }
    const scopes = typeof response.scope === 'string' ? response.scope.trim().split(/\s+/) : [];
    const seconds = typeof response.expires_in === 'number' ? response.expires_in
      : typeof response.expires_in === 'string' && /^\d+$/.test(response.expires_in) ? Number(response.expires_in) : NaN;
    if (response.error || typeof response.access_token !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(response.access_token)
      || response.access_token.length > 8192 || !Number.isFinite(seconds) || seconds * 1000 <= TOKEN_EXPIRY_MARGIN_MS
      || !scopes.length || scopes.some(scope => scope !== DRIVE_SCOPE)
      || (response.token_type !== undefined && (typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer'))) {
      throw new Error('선택한 Drive 파일에 대한 접근 권한과 연결 만료 시간을 확인하지 못했습니다. 다시 동의해 주세요.');
    }
    this.#expiresAt = Math.min(this.#expiresAt, Date.now() + seconds * 1000 - TOKEN_EXPIRY_MARGIN_MS);
    this.#token = response.access_token;
    this.#phase = 'authorized';
    this.armDeadline(this.#expiresAt);
    return true;
  }

  private requireToken(): string {
    this.signal.throwIfAborted();
    if (!this.#token || !['authorized', 'transferring'].includes(this.#phase)) throw new Error('Google 연결이 종료되었습니다. 다시 연결해 주세요.');
    if (Date.now() >= this.#expiresAt) {
      this.cancel(new DOMException('Google 연결이 만료되었습니다. 다시 연결해 주세요.', 'TimeoutError'));
      this.signal.throwIfAborted();
    }
    return this.#token!;
  }

  tokenForPicker(): string { return this.requireToken(); }

  beginTransfer(timeoutMs = 30000): void {
    this.requireToken();
    if (this.#phase !== 'authorized') throw new Error('Drive 파일을 이미 가져오고 있습니다.');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Google Drive 전송 시간을 확인하지 못했습니다.');
    this.#phase = 'transferring';
    this.#expiresAt = Math.min(this.#expiresAt, Date.now() + Math.max(1, Math.min(timeoutMs, 60000)));
    this.armDeadline(this.#expiresAt);
  }

  request(url: string, init: Pick<RequestInit, 'method' | 'headers' | 'body'> = {}): Promise<Response> {
    if (this.#phase !== 'transferring') throw new Error('Google Drive 전송이 시작되지 않았습니다.');
    const method = init.method || 'GET';
    const target = driveRequestUrl(url, method);
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + this.requireToken());
    return fetch(target, {
      ...init, method, headers, signal: this.signal, credentials: 'omit', cache: 'no-store',
      mode: 'cors', redirect: 'error', referrerPolicy: 'no-referrer',
    });
  }

  /** Clear before handing downloaded content to the application upload API. */
  release(): void {
    this.#token = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#phase !== 'cancelled') this.#phase = 'released';
  }

  cancel(reason: unknown = new DOMException('Drive 연결이 취소되었습니다.', 'AbortError')): void {
    this.release();
    this.#phase = 'cancelled';
    this.#controller.abort(reason);
  }
}

async function boundedText(response: Response, maximum: number, tooLarge: string): Promise<string> {
  if (!response.body) throw new Error('Google Drive 응답을 읽지 못했습니다.');
  const declared = response.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body.cancel();
    throw new Error(tooLarge);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, result = '', finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { finished = true; break; }
      size += value.byteLength;
      if (size > maximum) throw new Error(tooLarge);
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    if (!finished) { try { await reader.cancel(); } catch { /* Already aborted by the session. */ } }
    reader.releaseLock();
  }
}

export async function selectedDriveFile(id: string, session: DriveAccessSession): Promise<File> {
  try {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new Error('선택한 Drive 파일을 확인할 수 없습니다.');
    session.beginTransfer();
    const endpoint = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id);
    const metadata = await session.request(endpoint + '?fields=id,name,mimeType,size,capabilities(canDownload)&supportsAllDrives=true');
    if (!metadata.ok) {
      await metadata.body?.cancel();
      throw new Error(metadata.status === 401 ? 'Google 연결이 만료되었습니다. 다시 연결해 주세요.' : '선택한 파일을 읽을 권한이 없습니다. Google Drive 공유 설정을 확인해 주세요.');
    }
    const file: unknown = JSON.parse(await boundedText(metadata, MAX_METADATA_BYTES, 'Drive 파일 정보가 너무 큽니다.'));
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Drive 파일 정보를 읽지 못했습니다.');
    const item = file as { id?: string; name?: string; mimeType?: string; size?: string; capabilities?: { canDownload?: boolean } };
    if (item.id !== id || typeof item.name !== 'string' || typeof item.mimeType !== 'string') throw new Error('Drive 파일 정보를 읽지 못했습니다.');
    if (item.capabilities?.canDownload !== true) throw new Error('소유자가 다운로드를 허용하지 않은 파일입니다.');
    const exportType = googleExports.get(item.mimeType);
    if (!exportType && !DRIVE_SELECTABLE_MIME_TYPES.includes(item.mimeType)) throw new Error('Google 문서, 스프레드시트, 프레젠테이션 또는 텍스트 파일을 선택해 주세요.');
    if (!exportType && (typeof item.size !== 'string' || !/^\d+$/.test(item.size) || !Number.isSafeInteger(Number(item.size)))) throw new Error('Drive 파일 크기를 확인하지 못했습니다.');
    if (!exportType && Number(item.size) > MAX_DRIVE_FILE_BYTES) throw new Error('첨부 파일은 128KB 이하여야 합니다.');
    const downloadUrl = exportType ? endpoint + '/export?mimeType=' + encodeURIComponent(exportType.mime) : endpoint + '?alt=media';
    const response = await session.request(downloadUrl);
    if (!response.ok) { await response.body?.cancel(); throw new Error('선택한 파일을 가져오지 못했습니다. 다운로드 권한과 Google 연결을 확인해 주세요.'); }
    const text = await boundedText(response, MAX_DRIVE_FILE_BYTES, '내보낸 문서가 128KB를 넘습니다. 문서를 나누어 첨부해 주세요.');
    session.signal.throwIfAborted();
    if (text.includes('\0')) throw new Error('텍스트로 읽을 수 있는 파일을 선택해 주세요.');
    // Match the server's plain-name policy before constructing the uploaded File.
    const baseName = item.name.replace(/[\u0000-\u001f\u007f-\u009f/\\:\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '_').slice(0, 130) || 'Drive 문서';
    const name = exportType ? baseName + '.' + exportType.extension
      : /\.(txt|md|csv|json|ts|tsx|js|jsx|py|html|css|xml|yaml|yml|sql)$/i.test(baseName) ? baseName : baseName + '.txt';
    return new File([text], name, { type: exportType?.mime || 'text/plain', lastModified: Date.now() });
  } finally { session.release(); }
}
