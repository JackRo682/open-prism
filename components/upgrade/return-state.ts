/** Callback handling is separate from the view so recovery rules can be tested. */
export type PaymentReturnInput = { orderId: string; paymentKey?: string; amount?: number; cancelled: boolean };
export type PaymentReturnStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const PREFIX = 'prism:payment-return:v1:';
export const PAYMENT_RETURN_TTL_MS = 10 * 60 * 1000;

const validOrder = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(value);
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const validAmount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function parsePaymentReturn(search: string, kind: 'success' | 'fail', fallbackOrderId?: string | null): PaymentReturnInput {
  const query = new URLSearchParams(search);
  const orderId = query.get('orderId') || query.get('order') || (kind === 'fail' ? fallbackOrderId : null);
  if (!validOrder(orderId) || query.getAll('orderId').length > 1 || query.getAll('order').length > 1 ||
      (query.has('orderId') && query.has('order') && query.get('orderId') !== query.get('order'))) {
    throw new Error('주문 정보를 확인할 수 없습니다. 충전 내역에서 주문을 확인해 주세요.');
  }
  const cancelled = ['USER_CANCEL', 'PAY_PROCESS_CANCELED'].includes(query.get('code') || '');
  if (kind === 'fail') return { orderId, cancelled };
  if (!query.has('paymentKey') && !query.has('amount')) return { orderId, cancelled };
  const paymentKey = query.get('paymentKey');
  const amountText = query.get('amount') || '';
  const amount = Number(amountText);
  if (!validKey(paymentKey) || query.getAll('paymentKey').length !== 1 || query.getAll('amount').length !== 1 ||
      !/^[1-9]\d{0,15}$/.test(amountText) || !validAmount(amount)) {
    throw new Error('결제 확인 정보가 올바르지 않습니다. 충전 내역에서 결제 상태를 다시 확인해 주세요.');
  }
  return { orderId, paymentKey, amount, cancelled };
}

/** Payment keys never enter persistent storage or authentication return URLs. */
export function storePaymentReturn(storage: PaymentReturnStorage | null, input: PaymentReturnInput, now = Date.now()): boolean {
  if (!storage || !validOrder(input.orderId) || !validKey(input.paymentKey) || !validAmount(input.amount) || !Number.isSafeInteger(now)) return false;
  try {
    storage.setItem(PREFIX + input.orderId, JSON.stringify({ orderId: input.orderId, paymentKey: input.paymentKey, amount: input.amount, createdAt: now }));
    return true;
  } catch { return false; }
}

export function readPaymentReturn(storage: PaymentReturnStorage | null, orderId: string, now = Date.now()): PaymentReturnInput | null {
  if (!storage || !validOrder(orderId)) return null;
  const key = PREFIX + orderId;
  try {
    const saved = JSON.parse(storage.getItem(key) || 'null');
    if (saved && saved.orderId === orderId && validKey(saved.paymentKey) && validAmount(saved.amount) &&
        Number.isSafeInteger(saved.createdAt) && now >= saved.createdAt && now - saved.createdAt < PAYMENT_RETURN_TTL_MS) {
      return { orderId, paymentKey: saved.paymentKey, amount: saved.amount, cancelled: false };
    }
    storage.removeItem(key);
  } catch { try { storage.removeItem(key); } catch { /* Storage access can be denied. */ } }
  return null;
}

export function clearPaymentReturn(storage: PaymentReturnStorage | null, orderId: string): void {
  if (!storage || !validOrder(orderId)) return;
  try { storage.removeItem(PREFIX + orderId); } catch { /* The short-lived entry is never used without validation. */ }
}

export function paymentReturnStorage(): PaymentReturnStorage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}

/** Rebuild the auth return path from an allowlisted route and validated order ID. */
export function paymentAuthReturnPath(kind: 'success' | 'fail', orderId: string): string {
  return (kind === 'success' || kind === 'fail') && validOrder(orderId) ? `/upgrade/${kind}?orderId=${encodeURIComponent(orderId)}` : '/upgrade';
}
