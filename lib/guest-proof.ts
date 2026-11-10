/** Browser-only guest challenges. No provider or signing secret is used here. */
export type GuestChallenge =
  | {kind: 'proof-of-work'; token: string; difficulty: number; expiresAt: string}
  | {kind: 'turnstile'; siteKey: string; action: string};

/** Refresh an expired/rotated guest cookie once, without retrying inference. */
export async function loadGuestChallenge(signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const get = async (path: string) => {
    signal.throwIfAborted();
    const response = await fetcher(path, {credentials: 'same-origin', cache: 'no-store', signal});
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('보안 확인을 시작하지 못했습니다. 다시 시도해주세요.');
    return {response, value: raw as Record<string, unknown>};
  };
  let result = await get('/api/guest/challenge');
  if (result.response.status === 401 && result.value.code === 'GUEST_SESSION_REQUIRED') {
    const renewed = await get('/api/guest/bootstrap');
    if (!renewed.response.ok) return renewed;
    result = await get('/api/guest/challenge');
  }
  return result;
}

type Turnstile = {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
};
let turnstileLoading: Promise<Turnstile> | undefined;
const api = () => (window as Window & {turnstile?: Turnstile}).turnstile;

function loadTurnstile(): Promise<Turnstile> {
  if (api()) return Promise.resolve(api()!);
  if (turnstileLoading) return turnstileLoading;
  const pending = new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    const timer = setTimeout(() => {script.remove(); reject(new Error('보안 확인을 불러오지 못했습니다. 다시 시도해주세요.'));}, 15000);
    script.onload = () => {clearTimeout(timer); api() ? resolve(api()!) : reject(new Error('보안 확인을 불러오지 못했습니다.'));};
    script.onerror = () => {clearTimeout(timer); script.remove(); reject(new Error('보안 확인에 연결하지 못했습니다.'));};
    document.head.appendChild(script);
  });
  turnstileLoading = pending.catch(error => {turnstileLoading = undefined; throw error;});
  return turnstileLoading;
}

async function turnstileToken(challenge: Extract<GuestChallenge, {kind: 'turnstile'}>, container: HTMLElement, signal: AbortSignal): Promise<string> {
  const turnstile = await loadTurnstile();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let widget: string | undefined, settled = false;
    const complete = (error?: Error, token?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted);
      if (widget !== undefined) turnstile.remove(widget);
      container.replaceChildren();
      if (error) reject(error); else resolve(token!);
    };
    const aborted = () => complete(new DOMException('Request aborted', 'AbortError'));
    const timer = setTimeout(() => complete(new Error('보안 확인 시간이 초과되었습니다. 다시 시도해주세요.')), 90000);
    signal.addEventListener('abort', aborted, {once: true});
    try {
      widget = turnstile.render(container, {sitekey: challenge.siteKey, action: challenge.action, theme: 'auto',
        callback: (token: string) => complete(undefined, token),
        'error-callback': () => complete(new Error('보안 확인에 실패했습니다. 다시 시도해주세요.')),
        'expired-callback': () => complete(new Error('보안 확인이 만료되었습니다. 다시 시도해주세요.'))});
    } catch { complete(new Error('보안 확인을 시작하지 못했습니다.')); }
  });
}

export async function solveGuestChallenge(challenge: GuestChallenge, signal: AbortSignal, container?: HTMLElement | null) {
  signal.throwIfAborted();
  if (challenge.kind === 'turnstile') {
    if (!container || challenge.action !== 'guest_chat' || !/^[\w-]{10,100}$/.test(challenge.siteKey)) throw new Error('보안 확인을 시작하지 못했습니다.');
    return {turnstileToken: await turnstileToken(challenge, container, signal)};
  }
  if (challenge.kind !== 'proof-of-work' || ![15, 17].includes(challenge.difficulty)
    || !/^v1\.\d{13}\.(15|17)\.[a-f\d]{32}\.[a-f\d]{64}$/.test(challenge.token)
    || !Number.isFinite(Date.parse(challenge.expiresAt))) throw new Error('보안 확인을 시작하지 못했습니다.');
  const encoder = new TextEncoder(), whole = Math.floor(challenge.difficulty / 8), remainder = challenge.difficulty % 8;
  const deadline = Math.min(Date.now() + 20000, Date.parse(challenge.expiresAt));
  // Native asynchronous hashing and bounded batches keep typing/navigation
  // responsive. Computation happens only when sending a guest message.
  for (let start = 0; start < 4_194_304; start += 128) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('보안 확인 시간이 초과되었습니다. 다시 시도해주세요.');
    const candidates = await Promise.all(Array.from({length: 128}, async (_, index) => {
      const solution = (start + index).toString(16);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(challenge.token + ':' + solution)));
      return digest.slice(0, whole).every(value => value === 0) && (!remainder || digest[whole] >> (8 - remainder) === 0) ? solution : null;
    }));
    const solution = candidates.find(value => value !== null);
    if (solution !== undefined) {signal.throwIfAborted(); return {proof: {token: challenge.token, solution}};}
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  throw new Error('보안 확인을 다시 시도해주세요.');
}
