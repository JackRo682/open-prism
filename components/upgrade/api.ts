export class UpgradeApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

export async function upgradeRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 45_000);
  try {
    const response = await fetch(`/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const raw: unknown = await response.json().catch(() => null);
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!response.ok) throw new UpgradeApiError(
      typeof data?.error === 'string' ? data.error : '요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      response.status,
      typeof data?.code === 'string' ? data.code : undefined,
    );
    if (!data || typeof data !== 'object') throw new UpgradeApiError('서버 응답을 확인하지 못했습니다.', 502);
    return data as T;
  } catch (cause) {
    if (cause instanceof UpgradeApiError || signal?.aborted) throw cause;
    throw new UpgradeApiError(timedOut ? '응답 확인 시간이 초과되었습니다. 같은 주문으로 다시 확인해 주세요.' : '네트워크 연결을 확인한 뒤 다시 시도해 주세요.', 503, timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export const formatWon = (amount: number, fractional = false) =>
  `₩${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: fractional ? 6 : 0 }).format(amount)}`;

export function upgradeSignInHref(returnTo = '/upgrade'): string {
  // Rebuild an allowlisted route/query. In particular, never forward paymentKey
  // to authentication, even if a caller accidentally passes the callback URL.
  let safe = '/upgrade';
  try {
    const url = new URL(returnTo, 'https://prism.invalid');
    if (url.origin === 'https://prism.invalid' && ['/upgrade', '/upgrade/success', '/upgrade/fail'].includes(url.pathname)) {
      const query = new URLSearchParams();
      const key = url.pathname === '/upgrade' ? 'product' : 'orderId';
      const value = url.searchParams.get(key);
      if (url.searchParams.getAll(key).length === 1 && value && /^[A-Za-z0-9_-]{1,64}$/.test(value)) query.set(key, value);
      safe = url.pathname + (query.size ? `?${query}` : '');
    }
  } catch { /* An invalid return URL falls back to the upgrade page. */ }
  return `/signin-with-chatgpt?return_to=${encodeURIComponent(safe)}`;
}

const PENDING_KEY = 'prism:pending-payment:v1';
export function rememberPendingOrder(orderId: string): void {
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ orderId, createdAt: Date.now() })); } catch { /* Callback/server lookup is still available. */ }
}
export function pendingOrderId(): string | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
    if (typeof saved?.orderId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(saved.orderId) &&
        Number.isFinite(saved.createdAt) && Date.now() - saved.createdAt >= 0 && Date.now() - saved.createdAt < 24 * 60 * 60 * 1000) return saved.orderId;
    sessionStorage.removeItem(PENDING_KEY);
  } catch { /* Storage is optional. */ }
  return null;
}
export function forgetPendingOrder(orderId: string): void {
  try { if (pendingOrderId() === orderId) sessionStorage.removeItem(PENDING_KEY); } catch { /* Storage is optional. */ }
}
