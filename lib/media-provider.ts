import { WorkspaceToolError, type WorkspaceEnvironment } from './workspace-tools';
import { inspectImageStructure, validPngRaster } from './upload-security';

export const DEFAULT_IMAGE_MODEL = 'gpt-image-2.5-flare';
export const DEFAULT_VIDEO_MODEL = 'gemini-omni-1.1-flash';
export const DEFAULT_MUSIC_MODEL = 'lyria-3-clip-preview';
export const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
export type MediaKind = 'image' | 'video' | 'music';
export type MediaUsage = { input: number; output: number; textInput?: number; imageInput?: number };
export type MediaInput = {
  prompt: string;
  reference?: { bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; name?: string };
  aspect?: '16:9' | '9:16';
  safetyIdentifier?: string;
};
export type MediaAsset = {
  bytes: Uint8Array;
  mimeType: string;
  model: string;
  usage?: MediaUsage;
  text?: string;
  revisedPrompt?: string;
};
export type VideoJob = {
  provider: 'google'; model: string; fileName: string;
  interactionId?: string; usage?: MediaUsage;
};
export type VideoResult = { status: 'completed'; asset: MediaAsset } | { status: 'processing'; job: VideoJob };

export function mediaModel(env: WorkspaceEnvironment, kind: MediaKind): string {
  const model = (kind === 'image' ? env.OPENAI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL
    : kind === 'video' ? env.GEMINI_VIDEO_MODEL || DEFAULT_VIDEO_MODEL
      : env.GEMINI_MUSIC_MODEL || DEFAULT_MUSIC_MODEL).trim();
  // These families have verified API contracts. Retired Sora/Veo routes are never selected.
  const supported = kind === 'image' ? /^gpt-image-2\.5-(?:flare|sunburst)(?:-2026-09-08)?$/
    : kind === 'video' ? /^gemini-omni-1\.1-flash$/ : /^lyria-(?:3-clip-preview|3\.5)$/;
  if (!supported.test(model)) throw new WorkspaceToolError('설정된 생성 모델을 지원하지 않습니다. 연결 설정의 모델 이름을 확인해주세요.', 503, 'MEDIA_MODEL_NOT_SUPPORTED');
  return model;
}

function providerKey(env: WorkspaceEnvironment, kind: MediaKind): string {
  const key = kind === 'image' ? env.OPENAI_API_KEY : env.GEMINI_API_KEY;
  const enabled = kind === 'image' ? env.IMAGE_GENERATION_ENABLED : kind === 'video' ? env.VIDEO_GENERATION_ENABLED : env.MUSIC_GENERATION_ENABLED;
  if (!key || enabled === 'false') {
    const label = kind === 'image' ? '이미지' : kind === 'video' ? '동영상' : '음악';
    throw new WorkspaceToolError(`${label} 생성에는 ${kind === 'image' ? 'OpenAI 이미지' : 'Google Gemini'} API 연결이 필요합니다. 설정에서 연결 상태를 확인해주세요.`, 503, `${kind.toUpperCase()}_GENERATION_NOT_CONFIGURED`);
  }
  return key;
}

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

/** Validate the complete container before trusting its declared dimensions. */
export function referenceDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  return inspectImageStructure(bytes, mime);
}

export async function validateMediaInput(input: MediaInput) {
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 2000) throw new WorkspaceToolError('생성할 내용을 1~2,000자로 입력해주세요.', 400, 'INVALID_MEDIA_PROMPT');
  if (input.aspect !== undefined && !['16:9', '9:16'].includes(input.aspect)) throw new WorkspaceToolError('올바른 동영상 화면 비율을 선택해주세요.', 400, 'INVALID_VIDEO_ASPECT');
  if (input.safetyIdentifier !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(input.safetyIdentifier)) throw new WorkspaceToolError('요청 식별자가 올바르지 않습니다.', 400, 'INVALID_SAFETY_IDENTIFIER');
  if (input.reference) {
    const { bytes, mimeType } = input.reference;
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_REFERENCE_BYTES) throw new WorkspaceToolError('참조 이미지는 4MB 이하로 업로드해주세요.', 400, 'INVALID_REFERENCE_IMAGE');
    const dimensions = referenceDimensions(bytes, mimeType);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 2048 || dimensions.height > 2048
      || mimeType === 'image/png' && !await validPngRaster(bytes, 2048)) throw new WorkspaceToolError('참조 이미지는 가로·세로 각각 2,048px 이하의 PNG, JPEG, WebP 파일이어야 합니다.', 400, 'INVALID_REFERENCE_IMAGE');
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(binary);
}

function decodeMedia(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new WorkspaceToolError('생성 서비스에서 올바른 미디어 파일을 반환하지 않았습니다.', 502, 'INVALID_MEDIA_OUTPUT');
  let binary: string;
  try { binary = atob(value); } catch { throw new WorkspaceToolError('생성된 파일을 읽을 수 없습니다.', 502, 'INVALID_MEDIA_OUTPUT'); }
  if (!binary.length || binary.length > MAX_MEDIA_BYTES) throw new WorkspaceToolError('생성된 파일이 지원하는 크기를 초과했습니다.', 502, 'MEDIA_OUTPUT_TOO_LARGE');
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function checkAsset(bytes: Uint8Array, mime: string) {
  const dimensions = mime === 'image/png' ? referenceDimensions(bytes, mime) : null;
  const valid = mime === 'image/png' ? !!dimensions && dimensions.width > 0 && dimensions.height > 0 && dimensions.width <= 4096 && dimensions.height <= 4096 && await validPngRaster(bytes, 4096)
    : mime === 'video/mp4' ? bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp'
      : mime === 'audio/mpeg' ? (bytes.length >= 3 && ascii(bytes, 0, 3) === 'ID3') || (bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 224) === 224) : false;
  if (!valid) throw new WorkspaceToolError('생성 서비스에서 예상한 파일 형식을 반환하지 않았습니다.', 502, 'INVALID_MEDIA_OUTPUT');
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new WorkspaceToolError('생성된 파일이 지원하는 크기를 초과했습니다.', 502, 'MEDIA_OUTPUT_TOO_LARGE');
  }
  if (!response.body) throw new WorkspaceToolError('생성 서비스 응답이 비어 있습니다.', 502, 'EMPTY_MEDIA_RESPONSE');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new WorkspaceToolError('생성된 파일이 지원하는 크기를 초과했습니다.', 502, 'MEDIA_OUTPUT_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function providerJson(response: Response): Promise<Record<string, any>> {
  // Manual redirects reach this check as 3xx and are rejected before parsing.
  if (!response.ok) {
    // Provider bodies can contain echoed prompts or credentials; never forward them to clients or logs.
    await response.body?.cancel().catch(() => {});
    const messages: Record<number, string> = {
      400: '생성 서비스가 요청을 거절했습니다. 입력 파일, 모델 설정 또는 콘텐츠 제한을 확인해주세요.',
      401: '생성 서비스의 API 키를 확인해주세요.',
      403: '연결된 API 계정에 이 생성 모델의 사용 권한이 없습니다. 공급자 계정의 모델 접근 및 인증 상태를 확인해주세요.',
      404: '연결된 API 계정에서 생성 모델 또는 파일을 찾을 수 없습니다.',
      429: '생성 서비스의 사용 한도에 도달했습니다. 잠시 후 다시 시도해주세요.',
    };
    throw new WorkspaceToolError(messages[response.status] || '생성 서비스에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해주세요.', response.status === 429 ? 429 : 502, `MEDIA_PROVIDER_${response.status}`);
  }
  const bytes = await readBounded(response, Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 512 * 1024);
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, any>;
  } catch { throw new WorkspaceToolError('생성 서비스 응답을 읽을 수 없습니다.', 502, 'INVALID_MEDIA_RESPONSE'); }
}

function usageFrom(data: Record<string, any>): MediaUsage | undefined {
  const input = data.usage?.input_tokens ?? data.usage?.total_input_tokens;
  const output = data.usage?.output_tokens ?? data.usage?.total_output_tokens;
  if (![input, output].every(value => Number.isSafeInteger(value) && value >= 0) || output === 0) return undefined;
  const text = data.usage?.input_tokens_details?.text_tokens;
  const image = data.usage?.input_tokens_details?.image_tokens;
  return { input, output, ...(Number.isSafeInteger(text) && text >= 0 && Number.isSafeInteger(image) && image >= 0 && text + image === input ? { textInput: text, imageInput: image } : {}) };
}

export async function generateImage(env: WorkspaceEnvironment, input: MediaInput, signal: AbortSignal): Promise<MediaAsset> {
  const key = providerKey(env, 'image'), model = mediaModel(env, 'image');
  await validateMediaInput(input);
  const body: Record<string, unknown> = { model, prompt: input.prompt.trim(), n: 1, size: '1024x1024', quality: 'low', output_format: 'png', ...(input.safetyIdentifier ? { safety_identifier: input.safetyIdentifier } : {}) };
  if (input.reference) body.images = [{ image_url: `data:${input.reference.mimeType};base64,${base64(input.reference.bytes)}` }];
  const response = await fetch(`https://api.openai.com/v1/images/${input.reference ? 'edits' : 'generations'}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'manual',
  });
  const data = await providerJson(response);
  if (!Array.isArray(data.data) || data.data.length !== 1) throw new WorkspaceToolError('생성된 이미지를 찾을 수 없습니다.', 502, 'INVALID_MEDIA_OUTPUT');
  const bytes = decodeMedia(data.data[0]?.b64_json);
  await checkAsset(bytes, 'image/png');
  return { bytes, mimeType: 'image/png', model, usage: usageFrom(data), ...(typeof data.data[0]?.revised_prompt === 'string' ? { revisedPrompt: data.data[0].revised_prompt.slice(0, 32000) } : {}) };
}

function googleHeaders(key: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'Api-Revision': '2026-05-20' };
}

function googleContent(data: Record<string, any>): Array<Record<string, any>> {
  if (data.status && !['completed', 'complete'].includes(data.status)) throw new WorkspaceToolError('생성 서비스가 작업을 완료하지 못했습니다.', 502, 'MEDIA_GENERATION_INCOMPLETE');
  if (!Array.isArray(data.steps)) throw new WorkspaceToolError('생성 서비스의 결과가 비어 있습니다.', 502, 'EMPTY_MEDIA_OUTPUT');
  return data.steps.filter((step: any) => step?.type === 'model_output').flatMap((step: any) => Array.isArray(step.content) ? step.content : []);
}

function googleInput(input: MediaInput): string | Array<Record<string, string>> {
  return input.reference ? [{ type: 'image', data: base64(input.reference.bytes), mime_type: input.reference.mimeType }, { type: 'text', text: input.prompt.trim() }] : input.prompt.trim();
}

function googleFileName(value: unknown): string {
  if (typeof value !== 'string') throw new WorkspaceToolError('생성된 동영상의 파일 주소를 확인할 수 없습니다.', 502, 'INVALID_VIDEO_FILE');
  if (/^files\/[a-zA-Z0-9_-]{1,128}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://generativelanguage.googleapis.com' || url.username || url.password || url.hash) throw new Error();
    const match = /^\/v1beta\/(files\/[a-zA-Z0-9_-]{1,128})(?::download)?$/.exec(url.pathname);
    if (match) return match[1];
  } catch { /* Reject arbitrary URLs, paths, and credentials. */ }
  throw new WorkspaceToolError('생성된 동영상의 파일 주소가 올바르지 않습니다.', 502, 'INVALID_VIDEO_FILE');
}

export async function createVideo(env: WorkspaceEnvironment, input: MediaInput, signal: AbortSignal): Promise<VideoResult> {
  const key = providerKey(env, 'video'), model = mediaModel(env, 'video');
  await validateMediaInput(input);
  const data = await providerJson(await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: googleHeaders(key), signal, redirect: 'manual', body: JSON.stringify({
      model, input: googleInput(input), store: false, background: false, stream: false,
      response_format: { type: 'video', aspect_ratio: input.aspect ?? '16:9', resolution: '720p', delivery: 'uri' },
    }),
  }));
  const output = googleContent(data).find(content => content.type === 'video');
  if (!output) throw new WorkspaceToolError('생성 서비스에서 동영상을 반환하지 않았습니다.', 502, 'EMPTY_MEDIA_OUTPUT');
  const usage = usageFrom(data);
  if (typeof output.data === 'string' && output.data) {
    const bytes = decodeMedia(output.data);
    await checkAsset(bytes, 'video/mp4');
    return { status: 'completed', asset: { bytes, mimeType: 'video/mp4', model, usage } };
  }
  return { status: 'processing', job: { provider: 'google', model, fileName: googleFileName(output.uri), ...(typeof data.id === 'string' ? { interactionId: data.id } : {}), usage } };
}

export async function pollVideo(env: WorkspaceEnvironment, job: VideoJob, signal: AbortSignal): Promise<'processing' | 'completed'> {
  const key = providerKey(env, 'video'), name = googleFileName(job.fileName);
  if (job.provider !== 'google') throw new WorkspaceToolError('동영상 제공자가 올바르지 않습니다.', 400, 'INVALID_VIDEO_JOB');
  const data = await providerJson(await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, { headers: googleHeaders(key), signal, redirect: 'manual' }));
  const state = typeof data.state === 'string' ? data.state : data.state?.name;
  if (state === 'ACTIVE') return 'completed';
  if (state === 'PROCESSING' || state === 'STATE_UNSPECIFIED') return 'processing';
  if (state === 'FAILED') throw new WorkspaceToolError('동영상 처리가 실패했습니다. 다시 시도해주세요.', 502, 'VIDEO_PROCESSING_FAILED');
  throw new WorkspaceToolError('동영상 처리 상태를 확인할 수 없습니다.', 502, 'VIDEO_PROCESSING_STATUS_UNKNOWN');
}

export async function downloadVideo(env: WorkspaceEnvironment, job: VideoJob, signal: AbortSignal): Promise<MediaAsset> {
  const key = providerKey(env, 'video'), name = googleFileName(job.fileName);
  if (job.provider !== 'google') throw new WorkspaceToolError('동영상 제공자가 올바르지 않습니다.', 400, 'INVALID_VIDEO_JOB');
  let url = new URL(`https://generativelanguage.googleapis.com/v1beta/${name}:download?alt=media`);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 3; redirect++) {
    // Never forward Google's credential to a storage redirect host.
    response = await fetch(url.href, { headers: url.origin === 'https://generativelanguage.googleapis.com' ? { 'x-goog-api-key': key } : {}, signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location || redirect === 3) throw new WorkspaceToolError('동영상 다운로드가 올바르게 완료되지 않았습니다.', 502, 'VIDEO_DOWNLOAD_FAILED');
    let next: URL;
    try { next = new URL(location, url); }
    catch { throw new WorkspaceToolError('동영상 다운로드 주소를 확인할 수 없습니다.', 502, 'INVALID_VIDEO_FILE'); }
    if (next.protocol !== 'https:' || next.username || next.password || next.hash || next.port
      || !['generativelanguage.googleapis.com', 'storage.googleapis.com'].includes(next.hostname) && !next.hostname.endsWith('.googleusercontent.com')) throw new WorkspaceToolError('동영상 다운로드 주소를 확인할 수 없습니다.', 502, 'INVALID_VIDEO_FILE');
    if (next.hostname === 'generativelanguage.googleapis.com' && googleFileName(next.href) !== name) throw new WorkspaceToolError('동영상 파일이 일치하지 않습니다.', 502, 'INVALID_VIDEO_FILE');
    url = next;
  }
  if (!response!.ok) { await providerJson(response!); throw new WorkspaceToolError('동영상을 다운로드하지 못했습니다.', 502, 'VIDEO_DOWNLOAD_FAILED'); }
  const bytes = await readBounded(response!, MAX_MEDIA_BYTES);
  await checkAsset(bytes, 'video/mp4');
  return { bytes, mimeType: 'video/mp4', model: job.model, usage: job.usage };
}

export async function generateMusic(env: WorkspaceEnvironment, input: MediaInput, signal: AbortSignal): Promise<MediaAsset> {
  const key = providerKey(env, 'music'), model = mediaModel(env, 'music');
  await validateMediaInput(input);
  const data = await providerJson(await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: googleHeaders(key), signal, redirect: 'manual',
    body: JSON.stringify({ model, input: googleInput(input), store: false, background: false, stream: false, response_format: { type: 'audio' } }),
  }));
  const content = googleContent(data), output = content.find(part => part.type === 'audio');
  if (!output || (output.mime_type && !['audio/mpeg', 'audio/mp3'].includes(output.mime_type))) throw new WorkspaceToolError('생성 서비스에서 지원하는 음악 파일을 반환하지 않았습니다.', 502, 'EMPTY_MEDIA_OUTPUT');
  const bytes = decodeMedia(output.data);
  await checkAsset(bytes, 'audio/mpeg');
  const text = content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n').slice(0, 32000);
  return { bytes, mimeType: 'audio/mpeg', model, usage: usageFrom(data), ...(text ? { text } : {}) };
}
