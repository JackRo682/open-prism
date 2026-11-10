import { BETA_OUTPUT } from './beta';
import { DEFAULT_MODEL_ID, findModel } from './models';
import { invokeProvider, PROVIDER_INPUT_OVERHEAD_BYTES, type Turn } from './provider';
import { isRegenerateStyle, withRegenerateStyle } from './regenerate-style';
import { recordGenerationOutcome, trackProviderAttempt } from './security-monitoring';

/** Guest inference shares the existing, durable beta ledger and lifetime budget. */
export const GUEST_POLICY = Object.freeze({
  model: DEFAULT_MODEL_ID,
  sessionDailyRequests: 5,
  networkDailyRequests: 20,
  siteDailyRequests: 100,
  siteDailyBudgetMicros: 2_000_000,
  betaLifetimeBudgetMicros: 8_000_000,
  maxPromptBytes: 4_000,
  maxInputBytes: 12_000,
  maxHistoryTurns: 8,
  maxRequestBytes: 80_000,
  maxOutputTokens: BETA_OUTPUT,
  timeoutMs: 120_000,
});

const COOKIE = '__Host-prism-guest';
const SESSION_TTL = 7 * 86_400_000;
const SNAPSHOT_PREFIX = 'beta:guest:v1:';
const SIGN_IN_PATH = '/signin-with-chatgpt?return_to=%2Fchat';
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;
const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const dayStart = (now: number) => Math.floor(now / 86_400_000) * 86_400_000;
type GuestEnvironment = Pick<Cloudflare.Env, 'OPENAI_API_KEY' | 'GEMINI_API_KEY' | 'GUEST_CHAT_ENABLED'>;
type Identity = { owner: string; snapshot: string; cookie?: string };
type GuestInput = { requestId: string; turns: Turn[]; inputBound: number };
type Allowance = { sessionCount: number; networkCount: number; siteCount: number; dailyReserved: number; betaReserved: number };

class GuestError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

function json(data: unknown, status = 200, extras: HeadersInit = {}) {
  const headers = new Headers(extras);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Vary', 'Cookie');
  return Response.json(data, { status, headers });
}

function publicModel() {
  const model = findModel(GUEST_POLICY.model);
  return { id: GUEST_POLICY.model, name: model?.name || 'Gemini 3.5 Flash-Lite', provider: 'google' };
}

// Flash-Lite standard pricing: $0.30 input / $2.50 output per million tokens.
// Integer tenths of a micro-USD avoid floating-point over-rounding. The shared
// guest snapshot prefix remains unchanged so existing limits cannot reset.
const guestCost = (input: number, output: number) => Math.ceil((input * 3 + output * 25) / 10);

function publicLimits(now: number) {
  return {
    model: publicModel(), limit: GUEST_POLICY.sessionDailyRequests,
    resetsAt: new Date(dayStart(now) + 86_400_000).toISOString(),
    maxPromptBytes: GUEST_POLICY.maxPromptBytes, maxInputBytes: GUEST_POLICY.maxInputBytes,
    maxHistoryTurns: GUEST_POLICY.maxHistoryTurns, signInPath: SIGN_IN_PATH,
  };
}

function validateOrigin(req: Request) {
  const origin = req.headers.get('origin');
  const fetchSite = req.headers.get('sec-fetch-site');
  if (origin && origin !== new URL(req.url).origin || fetchSite === 'cross-site' || fetchSite === 'same-site') {
    throw new GuestError('INVALID_ORIGIN', '이 사이트에서 다시 요청해주세요.', 403);
  }
  // A JSON POST from our own browser always supplies Origin. Missing Origin is
  // not accepted for paid anonymous inference, even if a cookie is supplied.
  if (req.method !== 'GET' && !origin) throw new GuestError('INVALID_ORIGIN', '요청 출처를 확인할 수 없습니다.', 403);
}

/** Never trust X-Forwarded-For supplied by a caller. Missing edge IPs share a
 * restrictive bucket, so deleting cookies cannot create unlimited allowances. */
function networkBucket(req: Request) {
  const raw = req.headers.get('cf-connecting-ip')?.trim();
  if (!raw || raw.length > 64) return 'unresolved-network';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) {
    const octets = raw.split('.').map(Number);
    if (octets.every(value => value <= 255)) return octets.join('.');
    return 'unresolved-network';
  }
  if (!/^[a-f\d:.]+$/i.test(raw) || !raw.includes(':')) return 'unresolved-network';
  try {
    const canonical = new URL('http://[' + raw + ']/').hostname.slice(1, -1);
    const [head, tail] = canonical.split('::');
    const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
    const expanded = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    if (expanded.length !== 8) return 'unresolved-network';
    // IPv6 privacy addresses rotate within a /64; they must share a quota.
    return expanded.slice(0, 4).map(group => group.padStart(4, '0')).join(':') + '::/64';
  } catch { return 'unresolved-network'; }
}

async function signingKey(secret: string) {
  // Domain-separated HMAC uses the existing server-only key; no key or raw IP
  // is sent to the browser or retained in the guest ledger.
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sign(key: CryptoKey, scope: string, value: string) {
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode('openprism:guest:v1:' + scope + ':' + value)));
}
async function identity(req: Request, key: CryptoKey, now: number, create: boolean): Promise<Identity> {
  const cookieValue = req.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  let session = '';
  const scope = 'cookie:' + new URL(req.url).origin;
  const match = cookieValue && /^v1\.([a-f\d]{64})\.(\d{13})\.([a-f\d]{64})$/.exec(cookieValue);
  if (match) {
    const expiry = Number(match[2]);
    const signature = Uint8Array.from(match[3].match(/../g)!, value => parseInt(value, 16));
    if (expiry > now && expiry <= now + SESSION_TTL && await crypto.subtle.verify('HMAC', key, signature,
      encoder.encode('openprism:guest:v1:' + scope + ':' + match[1] + ':' + match[2]))) session = match[1];
  }
  let cookie: string | undefined;
  if (!session) {
    if (!create) throw new GuestError('GUEST_SESSION_REQUIRED', '체험 세션이 만료되었습니다. 페이지를 새로고침하고 다시 시도해주세요.', 401);
    session = hex(crypto.getRandomValues(new Uint8Array(32)));
    const expiry = now + SESSION_TTL;
    const value = 'v1.' + session + '.' + expiry + '.' + await sign(key, scope, session + ':' + expiry);
    cookie = COOKIE + '=' + value + '; Path=/; Max-Age=' + SESSION_TTL / 1000 + '; HttpOnly; Secure; SameSite=Lax';
  }
  const [owner, network] = await Promise.all([sign(key, 'session', session), sign(key, 'network', networkBucket(req))]);
  return { owner: 'guest:' + owner, snapshot: SNAPSHOT_PREFIX + network, cookie };
}

async function readInput(req: Request): Promise<GuestInput> {
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new GuestError('INVALID_CONTENT_TYPE', 'JSON 형식으로 요청해주세요.', 415);
  }
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > GUEST_POLICY.maxRequestBytes) throw new GuestError('REQUEST_TOO_LARGE', '메시지가 너무 깁니다.', 413);
  if (!req.body) throw new GuestError('INVALID_INPUT', '메시지를 입력해주세요.');
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > GUEST_POLICY.maxRequestBytes) {
        void reader.cancel();
        throw new GuestError('REQUEST_TOO_LARGE', '메시지가 너무 깁니다.', 413);
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new GuestError('INVALID_JSON', '요청 내용을 읽을 수 없습니다.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GuestError('INVALID_INPUT', '올바른 메시지를 입력해주세요.');
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some(key => !['requestId', 'prompt', 'history', 'regenerateStyle'].includes(key))) {
    throw new GuestError('INVALID_INPUT', '로그인 전에는 기본 텍스트 채팅만 사용할 수 있습니다.');
  }
  if (body.regenerateStyle !== undefined && !isRegenerateStyle(body.regenerateStyle)) {
    throw new GuestError('INVALID_INPUT', '응답 다시 생성 옵션을 확인해주세요.');
  }
  if (typeof body.requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(body.requestId)) {
    throw new GuestError('INVALID_REQUEST_ID', '올바른 요청 ID가 필요합니다.');
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new GuestError('INVALID_INPUT', '메시지를 입력해주세요.');
  const prompt = body.prompt.trim();
  if (byteLength(prompt) > GUEST_POLICY.maxPromptBytes) throw new GuestError('PROMPT_TOO_LARGE', '질문을 조금 더 짧게 입력해주세요.', 413);
  const history = body.history ?? [];
  if (!Array.isArray(history) || history.length > GUEST_POLICY.maxHistoryTurns || history.length % 2 !== 0) {
    throw new GuestError('INVALID_HISTORY', '이전 대화가 너무 길거나 올바르지 않습니다. 새 채팅을 시작해주세요.');
  }
  const turns: Turn[] = history.map((row: unknown, index: number) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new GuestError('INVALID_HISTORY', '이전 대화를 읽을 수 없습니다.');
    const turn = row as Record<string, unknown>;
    const role: Turn['role'] = index % 2 ? 'assistant' : 'user';
    if (Object.keys(turn).some(key => !['role', 'content'].includes(key)) || turn.role !== role || typeof turn.content !== 'string' || !turn.content.trim()) {
      throw new GuestError('INVALID_HISTORY', '이전 대화를 읽을 수 없습니다.');
    }
    return { role, content: turn.content.trim() };
  });
  turns.push({ role: 'user', content: prompt });
  const inputBytes = turns.reduce((total, turn) => total + byteLength(turn.content), 0);
  if (inputBytes > GUEST_POLICY.maxInputBytes) throw new GuestError('HISTORY_TOO_LARGE', '대화가 길어졌습니다. 새 채팅을 시작하거나 로그인해주세요.', 413);
  const styledPrompt = withRegenerateStyle(prompt, body.regenerateStyle);
  turns[turns.length - 1] = { role: 'user', content: styledPrompt };
  // Preserve the visitor's text limits while reserving for every added byte.
  return { requestId: body.requestId.toLowerCase(), turns, inputBound: inputBytes + byteLength(styledPrompt) - byteLength(prompt) + PROVIDER_INPUT_OVERHEAD_BYTES };
}

async function allowance(sql: D1Database, who: Identity, now: number): Promise<Allowance> {
  const day = dayStart(now);
  const row = await sql.prepare(`SELECT
    COALESCE(SUM(CASE WHEN user_id=? AND created_at>=? THEN 1 ELSE 0 END),0) AS sessionCount,
    COALESCE(SUM(CASE WHEN rate_snapshot=? AND created_at>=? THEN 1 ELSE 0 END),0) AS networkCount,
    COALESCE(SUM(CASE WHEN rate_snapshot LIKE 'beta:guest:v1:%' AND created_at>=? THEN 1 ELSE 0 END),0) AS siteCount,
    COALESCE(SUM(CASE WHEN rate_snapshot LIKE 'beta:guest:v1:%' AND created_at>=? THEN reserved_amount ELSE 0 END),0) AS dailyReserved,
    COALESCE(SUM(reserved_amount),0) AS betaReserved
    FROM usage WHERE rate_snapshot LIKE 'beta:%'`).bind(who.owner, day, who.snapshot, day, day, day).first<Allowance>();
  if (!row) throw new Error('Guest allowance unavailable.');
  return row;
}
const remaining = (state: Allowance) => Math.max(0, Math.min(
  GUEST_POLICY.sessionDailyRequests - state.sessionCount,
  GUEST_POLICY.networkDailyRequests - state.networkCount,
  GUEST_POLICY.siteDailyRequests - state.siteCount,
));
function budgetAvailable(state: Allowance, amount = guestCost(PROVIDER_INPUT_OVERHEAD_BYTES + 1, GUEST_POLICY.maxOutputTokens)) {
  return state.dailyReserved + amount <= GUEST_POLICY.siteDailyBudgetMicros && state.betaReserved + amount <= GUEST_POLICY.betaLifetimeBudgetMicros;
}
function siteBudgetAvailable(state: Allowance, amount = guestCost(PROVIDER_INPUT_OVERHEAD_BYTES + 1, GUEST_POLICY.maxOutputTokens)) {
  return state.betaReserved + amount <= GUEST_POLICY.betaLifetimeBudgetMicros;
}

/** All dimensions and the reservation are checked in one SQLite statement.
 * No read-then-increment or in-memory rate limit can race across workers. */
async function reserveGuest(sql: D1Database, who: Identity, ledgerId: string, amount: number, now: number) {
  const day = dayStart(now), activeSince = now - GUEST_POLICY.timeoutMs - 15_000;
  return sql.prepare(`INSERT INTO usage
    (id,user_id,model,provider,status,created_at,rate_snapshot,reserved_amount)
    SELECT ?,?,?,'google','pending',?,?,?
    WHERE (SELECT COUNT(*) FROM usage WHERE user_id=? AND created_at>=?) < ?
    AND (SELECT COUNT(*) FROM usage WHERE rate_snapshot=? AND created_at>=?) < ?
    AND (SELECT COUNT(*) FROM usage WHERE rate_snapshot LIKE 'beta:guest:v1:%' AND created_at>=?) < ?
    AND (SELECT COALESCE(SUM(reserved_amount),0) FROM usage WHERE rate_snapshot LIKE 'beta:guest:v1:%' AND created_at>=?) + ? <= ?
    AND (SELECT COALESCE(SUM(reserved_amount),0) FROM usage WHERE rate_snapshot LIKE 'beta:%') + ? <= ?
    AND (SELECT COUNT(*) FROM usage WHERE user_id=? AND status='pending' AND created_at>?) < 1
    AND (SELECT COUNT(*) FROM usage WHERE rate_snapshot=? AND status='pending' AND created_at>?) < 2
    AND (SELECT COUNT(*) FROM usage WHERE rate_snapshot LIKE 'beta:guest:v1:%' AND status='pending' AND created_at>?) < 4
    ON CONFLICT(id) DO NOTHING RETURNING id`).bind(
    ledgerId, who.owner, GUEST_POLICY.model, now, who.snapshot, amount,
    who.owner, day, GUEST_POLICY.sessionDailyRequests, who.snapshot, day, GUEST_POLICY.networkDailyRequests,
    day, GUEST_POLICY.siteDailyRequests, day, amount, GUEST_POLICY.siteDailyBudgetMicros,
    amount, GUEST_POLICY.betaLifetimeBudgetMicros, who.owner, activeSince, who.snapshot, activeSince, activeSince,
  ).first<{ id: string }>();
}

export async function handleGuest(req: Request, path: string[], sql: D1Database | undefined, environment: GuestEnvironment): Promise<Response | null> {
  if (path[0] !== 'guest') return null;
  let now = Date.now();
  try {
    validateOrigin(req);
    const bootstrap = path.length === 2 && path[1] === 'bootstrap' && req.method === 'GET';
    const chat = path.length === 2 && path[1] === 'chat' && req.method === 'POST';
    if (!bootstrap && !chat) return json({ error: 'Endpoint not found.', code: 'NOT_FOUND' }, 404);
    const model = findModel(GUEST_POLICY.model), providerKey = environment.GEMINI_API_KEY;
    // Preserve existing signed guest identities and quota buckets when the old
    // server key exists; it is never used for guest inference. New installations
    // need only the Gemini key. Missing Gemini access fails closed.
    const signingSecret = environment.OPENAI_API_KEY || providerKey;
    if (!sql || !providerKey || !signingSecret || !model || model.provider !== 'google' || environment.GUEST_CHAT_ENABLED === 'false') {
      return json({ ...publicLimits(now), available: false, remaining: 0, code: 'GUEST_UNAVAILABLE', error: '현재 체험 채팅을 이용할 수 없습니다. 잠시 후 다시 시도해주세요.' }, 503);
    }
    const key = await signingKey(signingSecret), who = await identity(req, key, now, bootstrap);
    if (bootstrap) {
      const state = await allowance(sql, who, now);
      const available = budgetAvailable(state), siteExhausted = !siteBudgetAvailable(state);
      return json({ ...publicLimits(now), available, remaining: available ? remaining(state) : 0,
        ...(!available ? siteExhausted
          ? { code: 'GUEST_SITE_LIMIT', limitKind: 'site', resetsAt: null, error: '현재 체험 서비스를 이용할 수 없습니다.' }
          : { code: 'GUEST_DAILY_LIMIT', limitKind: 'daily', error: '오늘의 체험 서비스 한도에 도달했습니다. 한도가 초기화된 후 다시 이용해주세요.' } : {}),
      }, 200, who.cookie ? { 'Set-Cookie': who.cookie } : {});
    }
    const input = await readInput(req);
    if (req.signal.aborted) throw new GuestError('GUEST_ABORTED', '요청이 취소되었습니다.', 408);
    // Slow request bodies must not start inference with an already stale lease
    // or use the preceding day's quota across the reset boundary.
    now = Date.now();
    const state = await allowance(sql, who, now);
    const ledgerId = 'guest:' + await sign(key, 'request', who.owner + ':' + input.requestId);
    const duplicate = () => sql.prepare('SELECT id FROM usage WHERE id=? AND user_id=?').bind(ledgerId, who.owner).first();
    if (await duplicate()) throw new GuestError('DUPLICATE_REQUEST', '이미 접수된 요청입니다. 새 질문으로 다시 시도해주세요.', 409);
    const amount = guestCost(input.inputBound, GUEST_POLICY.maxOutputTokens);
    if (!await reserveGuest(sql, who, ledgerId, amount, now)) {
      if (await duplicate()) throw new GuestError('DUPLICATE_REQUEST', '이미 접수된 요청입니다. 새 질문으로 다시 시도해주세요.', 409);
      const latest = await allowance(sql, who, now);
      // The existing beta lifetime ceiling does not reset tomorrow and also
      // applies to signed-in beta chat. Do not advertise either as a remedy.
      if (!siteBudgetAvailable(latest, amount)) return json({ available: false, code: 'GUEST_SITE_LIMIT', limitKind: 'site',
        error: '현재 체험 서비스를 이용할 수 없습니다.', remaining: 0, resetsAt: null,
      }, 503);
      const exhausted = remaining(latest) === 0 || !budgetAvailable(latest, amount);
      const retryAfter = exhausted ? Math.ceil((dayStart(now) + 86_400_000 - now) / 1000) : 15;
      return json({ code: exhausted ? 'GUEST_LIMIT_REACHED' : 'GUEST_BUSY',
        limitKind: exhausted ? 'daily' : 'busy',
        error: exhausted ? '로그인 전 체험 한도에 도달했습니다. 로그인하거나 한도가 초기화된 후 다시 이용해주세요.' : '응답이 진행 중입니다. 잠시 후 다시 시도해주세요.',
        remaining: exhausted ? 0 : remaining(latest), resetsAt: publicLimits(now).resetsAt,
      }, 429, { 'Retry-After': String(retryAfter) });
    }
    // Session and network limits are serialized by the reservation above. This
    // value is informational; every subsequent request rechecks the ledger.
    const left = Math.max(0, remaining(state) - 1);
    const aborter = new AbortController();
    let closed = false, timedOut = false, userAborted = false;
    const onAbort = () => { userAborted = true; aborter.abort(); };
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) onAbort();
    const timer = setTimeout(() => { timedOut = true; aborter.abort(); }, GUEST_POLICY.timeoutMs);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (value: unknown) => { if (!closed) controller.enqueue(encoder.encode('data: ' + JSON.stringify(value) + '\n\n')); };
        const generationStartedAt = Date.now(), monitoringId = crypto.randomUUID();
        let text = '', outcomeStatus = 200;
        try {
          emit({ type: 'start', requestId: input.requestId, model: model.id, remaining: left });
          if (aborter.signal.aborted) throw new DOMException('Request aborted.', 'AbortError');
          const measured = await trackProviderAttempt(sql, monitoringId, () => invokeProvider(model, providerKey, input.turns, 'minimal', false, aborter.signal, delta => {
            if (aborter.signal.aborted) throw new DOMException('Request aborted.', 'AbortError');
            text += delta; emit({ type: 'delta', text: delta });
          }, GUEST_POLICY.maxOutputTokens));
          if (aborter.signal.aborted) throw new DOMException('Request aborted.', 'AbortError');
          if (!text.trim()) throw new Error('The provider returned no text.');
          const charged = guestCost(measured.input, measured.output);
          if (charged > amount) throw new Error('Provider usage exceeded the reservation.');
          await sql.prepare("UPDATE usage SET status='complete',input_tokens=?,output_tokens=?,reserved_amount=?,duration=? WHERE id=? AND user_id=?")
            .bind(measured.input, measured.output, charged, Math.max(0, Date.now() - now), ledgerId, who.owner).run();
          emit({ type: 'done', requestId: input.requestId, model: model.id, remaining: left, usage: { input: measured.input, output: measured.output } });
        } catch (failure) {
          // Failures and cancellations keep their reservation: they may already
          // have incurred provider usage. Never store prompts or response text.
          const code = aborter.signal.aborted ? timedOut ? 'GUEST_TIMEOUT' : 'GUEST_ABORTED' : 'GUEST_PROVIDER_ERROR';
          outcomeStatus = userAborted ? 499 : timedOut || failure instanceof Error && failure.name === 'TimeoutError' ? 504
            : failure instanceof GuestError ? failure.status : 500;
          try { await sql.prepare("UPDATE usage SET status='error',error=?,duration=? WHERE id=? AND user_id=?")
            .bind(code, Math.max(0, Date.now() - now), ledgerId, who.owner).run(); } catch { /* Pending reservation fails closed until its concurrency lease expires. */ }
          emit({ type: 'error', code, remaining: left, error: code === 'GUEST_ABORTED' ? '응답이 중지되었습니다. 접수된 요청은 체험 한도에 포함됩니다.'
            : code === 'GUEST_TIMEOUT' ? '응답 시간이 초과되었습니다. 질문을 짧게 하여 다시 시도해주세요. 접수된 요청은 체험 한도에 포함됩니다.'
            : 'AI 응답을 완료하지 못했습니다. 잠시 후 다시 시도해주세요. 접수된 요청은 체험 한도에 포함됩니다.' });
        } finally {
          clearTimeout(timer); req.signal.removeEventListener('abort', onAbort);
          await recordGenerationOutcome(sql, { route: '/api/guest', requestId: monitoringId, status: outcomeStatus, startedAt: generationStartedAt });
          if (!closed) { closed = true; try { controller.close(); } catch { /* Client already disconnected. */ } }
        }
      },
      cancel() { closed = true; onAbort(); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Cookie' } });
  } catch (error) {
    if (error instanceof GuestError) return json({ code: error.code, error: error.message }, error.status);
    return json({ available: false, code: 'GUEST_UNAVAILABLE', error: '체험 채팅을 준비하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 503);
  }
}
