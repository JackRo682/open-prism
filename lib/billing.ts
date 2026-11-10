import { env } from 'cloudflare:workers';
import { MODELS } from './models';
import {
  BILLING_PRODUCTS, BILLING_TERMS_VERSION,
  type ActivePaymentMode, type BillingBusiness, type BillingTerms, type PaymentMode,
  type PaymentOrder, type PaymentState, type PaymentStatus, type UpgradeOverview,
} from './billing-contract';

// One unit is 1/1,000,000 KRW. All ledger arithmetic uses safe integers.
export const WON = 1_000_000;
export const TOP_UPS = BILLING_PRODUCTS.map(product => product.amount);
const ORDER_LIFETIME_MS = 24 * 60 * 60 * 1000;
// Toss retains API idempotency keys for 15 days. Stop automatic cancellation
// retries a day earlier rather than risk a second refund after key expiry.
const REFUND_RETRY_MS = 14 * 24 * 60 * 60 * 1000;
export type Rates = { input: number; output: number };
export type BillingConfig = {
  rates: Record<string, Rates>;
  refundPolicy: string;
  validityPolicy: string;
  registrationNumber: string;
  address: string;
  supportEmail: string;
};
export const emptyConfig: BillingConfig = { rates: {}, refundPolicy: '', validityPolicy: '', registrationNumber: '', address: '', supportEmail: '' };
export class BillingError extends Error {
  constructor(message: string, public status = 400, public code = 'BILLING_ERROR') { super(message); }
}

export function validateConfig(value: unknown): BillingConfig {
  const v = value as BillingConfig;
  if (!v || typeof v !== 'object' || !v.rates || typeof v.rates !== 'object' || Array.isArray(v.rates)) throw new BillingError('모델별 단가를 입력하세요.');
  const rates: Record<string, Rates> = {};
  for (const [id, rate] of Object.entries(v.rates)) {
    if (!MODELS.some(m => m.id === id) || !rate || !['input', 'output'].every(k => Number.isSafeInteger(rate[k as keyof Rates]) && rate[k as keyof Rates] > 0 && rate[k as keyof Rates] <= 1_000_000)) throw new BillingError('단가는 100만 토큰당 원화 정수(1~1,000,000원)로 입력하세요.');
    rates[id] = { input: rate.input, output: rate.output };
  }
  const result = { rates } as BillingConfig;
  for (const key of ['refundPolicy', 'validityPolicy', 'registrationNumber', 'address', 'supportEmail'] as const) {
    if (typeof v[key] !== 'string' || v[key].length > 4000) throw new BillingError('출시 설정 값이 올바르지 않습니다.');
    result[key] = v[key].trim();
  }
  if (result.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.supportEmail)) throw new BillingError('고객지원 이메일을 확인하세요.');
  return result;
}
export async function getBillingConfig(sql: D1Database): Promise<BillingConfig> {
  const row = await sql.prepare("SELECT value FROM billing_config WHERE key='launch'").first<{ value: string }>();
  return row ? validateConfig(JSON.parse(row.value)) : { ...emptyConfig, rates: {} };
}
export function launchBlockers(config: BillingConfig): string[] {
  const blockers: string[] = [];
  if (!Object.keys(config.rates).length) blockers.push('모델별 차감 단가 미확정');
  if (!config.refundPolicy) blockers.push('환불 기준 미확정');
  if (!config.validityPolicy) blockers.push('충전금 유효기간 미확정');
  if (!config.registrationNumber) blockers.push('사업자등록번호 미등록');
  if (!config.address) blockers.push('사업장 주소 미등록');
  if (!config.supportEmail) blockers.push('고객지원 이메일 미등록');
  return blockers;
}
function keyInfo(value: string | undefined, kind: 'ck' | 'sk') {
  const match = new RegExp(`^(test|live)_(g?)${kind}_\\S+$`).exec(value || '');
  if (value && /[\u0000-\u001f\u007f]/.test(value)) return null;
  return match ? { mode: match[1] as ActivePaymentMode, family: match[2], kind: match[2] ? 'widget' as const : 'payment' as const } : null;
}
function checkoutCredentials() {
  const client = keyInfo(env.TOSS_CLIENT_KEY, 'ck'), secret = keyInfo(env.TOSS_SECRET_KEY, 'sk');
  return client && secret && client.mode === secret.mode && client.family === secret.family ? client : null;
}
function secretFor(mode: ActivePaymentMode): string {
  if (keyInfo(env.TOSS_SECRET_KEY, 'sk')?.mode !== mode) throw new BillingError('이 주문의 결제 환경을 확인할 수 없습니다. 고객지원에 문의해 주세요.', 503, 'PAYMENT_ENVIRONMENT_UNAVAILABLE');
  return env.TOSS_SECRET_KEY!;
}
/** Only the new-purchase switch. Existing orders can still be reconciled when
 * checkout is disabled, provided their own environment's server key remains. */
export function paymentMode(config: BillingConfig): PaymentMode {
  const keys = checkoutCredentials();
  if (!keys || keys.mode !== env.PAYMENTS_MODE) return 'disabled';
  if (keys.mode === 'test') return 'test';
  return env.BETA_MODE !== 'true' && env.LAUNCH_APPROVED === 'true' && !launchBlockers(config).length ? 'live' : 'disabled';
}
function business(config: BillingConfig): BillingBusiness {
  return { name: '종합상사 루비', representative: '노휘석', registrationNumber: config.registrationNumber, address: config.address, supportEmail: config.supportEmail };
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function termsFor(config: BillingConfig): Promise<BillingTerms> {
  // Changing a displayed price, tariff, policy, or seller detail invalidates an
  // unsubmitted consent. Completed orders retain the exact accepted snapshot.
  const policyHash = await digest(JSON.stringify({
    version: BILLING_TERMS_VERSION, mode: paymentMode(config), business: business(config), products: BILLING_PRODUCTS,
    refundPolicy: config.refundPolicy, validityPolicy: config.validityPolicy,
    rates: Object.fromEntries(Object.entries(config.rates).sort(([a], [b]) => a.localeCompare(b))),
  }));
  return { version: BILLING_TERMS_VERSION, policyHash, refundPolicy: config.refundPolicy, validityPolicy: config.validityPolicy };
}
export async function upgradeOverview(sql: D1Database, owner?: string): Promise<UpgradeOverview> {
  const config = await getBillingConfig(sql), mode = paymentMode(config);
  return {
    signedIn: !!owner, beta: env.BETA_MODE === 'true', mode, checkoutAvailable: mode !== 'disabled',
    products: BILLING_PRODUCTS.map(product => ({ ...product })), terms: await termsFor(config), business: business(config),
    balance: owner ? await balance(sql, owner) : null, testBalance: owner ? await balance(sql, owner, 'test') : null,
  };
}
export async function balance(sql: D1Database, owner: string, mode = 'live'): Promise<number> {
  const row = await sql.prepare('SELECT COALESCE(SUM(amount),0) AS balance FROM wallet_events WHERE user_id=? AND mode=?').bind(owner, mode).first<{balance:number}>();
  const value = row?.balance ?? 0;
  if (!Number.isSafeInteger(value)) throw new BillingError('잔액 정산을 확인해 주세요.', 503, 'WALLET_BALANCE_INVALID');
  return value;
}
export async function reserve(sql: D1Database, owner: string, requestId: string, amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new BillingError('요청 비용을 계산할 수 없습니다.');
  // The balance predicate and debit run as one SQLite write statement, across
  // all conversations and Workers. No read-then-update race can overspend.
  const row = await sql.prepare(`INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at)
    SELECT ?,?,'live','reserve',?,?,? WHERE
    (SELECT COALESCE(SUM(amount),0) FROM wallet_events WHERE user_id=? AND mode='live') >= ?
    AND NOT EXISTS (SELECT 1 FROM account_flags WHERE user_id=?)
    AND (SELECT COUNT(*) FROM wallet_events r WHERE r.user_id=? AND r.mode='live' AND r.kind='reserve'
      AND NOT EXISTS (SELECT 1 FROM wallet_events s WHERE s.reference='settle:' || substr(r.reference,9))) < 3
    RETURNING id`).bind(crypto.randomUUID(),owner,-amount,'reserve:'+requestId,Date.now(),owner,amount,owner,owner).first();
  if (!row) throw new BillingError('사용 가능 잔액이 부족하거나 정산 대기 요청이 3개 있습니다. 충전 내역을 확인하세요.', 402);
}
export async function settle(sql: D1Database, owner: string, requestId: string, reserved: number, charge: number) {
  if (!Number.isSafeInteger(reserved) || reserved <= 0 || !Number.isSafeInteger(charge) || charge < 0 || charge > reserved) throw new BillingError('사용량 확인이 필요해 예약 잔액을 보류했습니다.', 503, 'USAGE_RECONCILIATION_REQUIRED');
  await sql.prepare(`INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at)
    SELECT ?,?,'live','settle',?,?,? WHERE EXISTS
    (SELECT 1 FROM wallet_events WHERE user_id=? AND mode='live' AND kind='reserve' AND reference=? AND amount=?)
    ON CONFLICT(reference) DO NOTHING`).bind(crypto.randomUUID(),owner,reserved-charge,'settle:'+requestId,Date.now(),owner,'reserve:'+requestId,-reserved).run();
  const applied=await sql.prepare('SELECT amount FROM wallet_events WHERE user_id=? AND reference=?').bind(owner,'settle:'+requestId).first<{amount:number}>();
  if(applied&&applied.amount!==reserved-charge)throw new BillingError('이미 다른 금액으로 정산된 요청입니다.',409,'SETTLEMENT_CONFLICT');
}
export function cost(rate: Rates, input: number, output: number) {
  if (!rate || ![rate.input,rate.output].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1_000_000) || ![input,output].every(n => Number.isSafeInteger(n) && n >= 0)) throw new BillingError('제공사 사용량을 검증하지 못했습니다.',503,'USAGE_RECONCILIATION_REQUIRED');
  const result = input * rate.input + output * rate.output;
  if (!Number.isSafeInteger(result)) throw new BillingError('사용량이 계산 범위를 초과했습니다.',503);
  return result;
}

type PaymentRow = {
  id: string; user_id: string; amount: number; mode: ActivePaymentMode; status: PaymentState;
  payment_key: string | null; candidate_payment_key: string | null; created_at: number; product_id: string | null; order_name: string | null;
  checkout_request_id: string | null; currency: string; terms_version: string | null; terms_hash: string | null;
  consent_snapshot: string | null; consented_at: number | null; refunded_amount: number;
  paid_at: number | null; expires_at: number | null; updated_at: number | null; provider_status: string | null;
};
type RefundRow = {
  id: string; payment_id: string; request_id: string; amount: number; baseline_refunded: number; reason: string;
  status: 'pending' | 'succeeded' | 'failed' | 'review'; idempotency_key: string; provider_cancel_key: string | null;
  submitted_at: number | null; created_at: number; lock_token: string | null; locked_until: number | null;
};
type ProviderCancel = { transactionKey: string; cancelAmount: number; cancelStatus?: string };
type ProviderPayment = {
  orderId: string; paymentKey: string; totalAmount: number; balanceAmount: number; currency: string;
  status: string; approvedAt?: string | null; cancels?: ProviderCancel[] | null; lastTransactionKey?: string;
};
const validOrderId = (value: unknown): value is string => typeof value === 'string' && /^prism_[a-f0-9]{32}$/.test(value);
// Provider identifiers are opaque. Bound their size and reject control bytes;
// do not assume that the provider's future identifier alphabet stays fixed.
const validPaymentKey = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 200 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new BillingError('요청 식별자가 올바르지 않습니다.', 400, 'INVALID_REQUEST_ID');
  return value.toLowerCase();
}
function onlyKeys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new BillingError('지원하지 않는 결제 요청 값입니다.', 400, 'INVALID_PAYMENT_INPUT');
}
async function requestText(req: Request, maxBytes = 8192): Promise<string> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') || '')) throw new BillingError('JSON 요청이 필요합니다.', 415, 'JSON_REQUIRED');
  if (Number(req.headers.get('content-length') || 0) > maxBytes) throw new BillingError('결제 요청이 너무 큽니다.', 413, 'PAYMENT_REQUEST_TOO_LARGE');
  const reader = req.body?.getReader();
  if (!reader) throw new BillingError('결제 요청을 확인할 수 없습니다.');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let size = 0, result = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new BillingError('결제 요청이 너무 큽니다.', 413, 'PAYMENT_REQUEST_TOO_LARGE'); }
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError('결제 요청을 읽을 수 없습니다.', 400, 'INVALID_PAYMENT_INPUT');
  } finally { reader.releaseLock(); }
}
function parseBody(text: string): Record<string, unknown> {
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new BillingError('올바른 JSON 요청이 필요합니다.', 400, 'INVALID_PAYMENT_INPUT'); }
  if (!record(body)) throw new BillingError('결제 요청을 확인할 수 없습니다.', 400, 'INVALID_PAYMENT_INPUT');
  return body;
}
async function throttle(sql: D1Database, key: string, count: number, duration: number) {
  const now = Date.now(), expires = now + duration;
  const allowed = await sql.prepare(`INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
    expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END
    WHERE expires_at<=? OR count<? RETURNING key`).bind(key, expires, now, now, expires, now, count).first();
  if (!allowed) throw new BillingError('잠시 후 같은 주문으로 다시 시도해 주세요.', 429, 'PAYMENT_RATE_LIMIT');
}
class TossFailure extends BillingError {
  constructor(public providerCode: string, public providerStatus: number, public definitive: boolean) {
    super('결제 제공사 확인을 완료하지 못했습니다. 새로 결제하지 말고 같은 주문을 다시 확인해 주세요.', 502, 'PAYMENT_PROVIDER_UNAVAILABLE');
  }
}
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
async function readProviderResponse(response: Response): Promise<unknown> {
  // Provider responses are an untrusted input boundary too. Bound decoded
  // transfer bytes before parsing, including error bodies and responses that
  // omit or understate Content-Length. A bad response does not prove that a
  // payment/refund failed, so preserve its existing idempotency key and hold.
  if (Number(response.headers.get('content-length')) > MAX_PROVIDER_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new TossFailure('RESPONSE_TOO_LARGE', response.status, false);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TossFailure('INVALID_RESPONSE', response.status, false);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) throw new TossFailure('RESPONSE_TOO_LARGE', response.status, false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    // Cancellation is best-effort; do not let an upstream cancellation delay
    // turn a bounded failure into another unbounded wait.
    void reader.cancel().catch(() => {});
    if (error instanceof TossFailure) throw error;
    throw new TossFailure('INVALID_RESPONSE', response.status, false);
  } finally { reader.releaseLock(); }
}
async function toss(mode: ActivePaymentMode, path: string, method = 'GET', body?: unknown, idempotency?: string): Promise<ProviderPayment> {
  const key = secretFor(mode);
  let response: Response;
  try {
    response = await fetch('https://api.tosspayments.com/v1/payments' + path, {
      method, headers: { Authorization: 'Basic ' + btoa(key + ':'), 'Content-Type': 'application/json', ...(idempotency ? { 'Idempotency-Key': idempotency } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: 'manual',
    });
  } catch { throw new TossFailure('NETWORK_ERROR', 0, false); }
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => {});
    throw new TossFailure('UNEXPECTED_REDIRECT', response.status, false);
  }
  const data = await readProviderResponse(response);
  if (!response.ok) {
    const code = record(data) && typeof data.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(data.code) ? data.code : 'PROVIDER_ERROR';
    // A conflict/timeout or processing response can describe an earlier call
    // that is still executing. A current unchanged GET is not proof that the
    // operation will fail; retain its reservation and idempotency key.
    const processing = /PROCESSING|IN_PROGRESS|IDEMPOTENT/.test(code);
    const definitive = response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status) && !processing;
    throw new TossFailure(code, response.status, definitive);
  }
  if (!record(data)) throw new TossFailure('INVALID_RESPONSE', response.status, false);
  return data as unknown as ProviderPayment;
}
function notFound(error: unknown) { return error instanceof TossFailure && (error.providerStatus === 404 || error.providerCode === 'NOT_FOUND_PAYMENT' || error.providerCode === 'NOT_FOUND_PAYMENT_SESSION'); }
function validateSnapshot(order: PaymentRow, payment: ProviderPayment, expectedKey?: string) {
  if (!payment || payment.orderId !== order.id || !validPaymentKey(payment.paymentKey) ||
      (expectedKey && payment.paymentKey !== expectedKey) || (order.payment_key && payment.paymentKey !== order.payment_key) ||
      payment.currency !== 'KRW' || order.currency !== 'KRW' || !Number.isSafeInteger(order.amount * WON) || !Number.isSafeInteger(payment.totalAmount) || payment.totalAmount !== order.amount ||
      !Number.isSafeInteger(payment.balanceAmount) || payment.balanceAmount < 0 || payment.balanceAmount > order.amount ||
      !['READY', 'IN_PROGRESS', 'WAITING_FOR_DEPOSIT', 'DONE', 'CANCELED', 'PARTIAL_CANCELED', 'ABORTED', 'EXPIRED'].includes(payment.status)) {
    throw new BillingError('결제 정보가 저장된 주문과 일치하지 않습니다.', 409, 'PAYMENT_MISMATCH');
  }
  if (payment.cancels != null && !Array.isArray(payment.cancels)) throw new BillingError('환불 내역을 검증할 수 없습니다.', 502, 'INVALID_PROVIDER_REFUND');
  const keys = new Set<string>();
  let canceled = 0;
  const done: string[] = [], failed: string[] = [];
  for (const cancel of payment.cancels || []) {
    if (!cancel || !validPaymentKey(cancel.transactionKey) || keys.has(cancel.transactionKey) ||
        !Number.isSafeInteger(cancel.cancelAmount) || cancel.cancelAmount <= 0 || cancel.cancelAmount > order.amount ||
        !['DONE', 'IN_PROGRESS', 'FAILED'].includes(cancel.cancelStatus || '')) {
      throw new BillingError('환불 내역을 검증할 수 없습니다.', 502, 'INVALID_PROVIDER_REFUND');
    }
    keys.add(cancel.transactionKey);
    if (cancel.cancelStatus === 'FAILED') failed.push(cancel.transactionKey);
    else if (cancel.cancelStatus === 'DONE') { canceled += cancel.cancelAmount; done.push(cancel.transactionKey); }
  }
  const unpaidCancellation = payment.status === 'CANCELED' && !payment.approvedAt;
  if (!Number.isSafeInteger(canceled) || canceled > order.amount ||
      (canceled !== order.amount - payment.balanceAmount && !(unpaidCancellation && canceled === 0 && payment.balanceAmount === 0)) ||
      (payment.status === 'DONE' && canceled !== 0) || (payment.status === 'CANCELED' && canceled !== order.amount) ||
      (payment.status === 'PARTIAL_CANCELED' && (canceled <= 0 || canceled >= order.amount)) ||
      (!['DONE', 'CANCELED', 'PARTIAL_CANCELED'].includes(payment.status) && canceled !== 0)) {
    // Cancelling an unpaid virtual account may have no cash cancellation
    // transaction. It must not mint a gross credit and matching refund.
    if (!(unpaidCancellation && canceled === 0 && (payment.balanceAmount === 0 || payment.balanceAmount === order.amount))) {
      throw new BillingError('결제 잔액과 환불 내역이 일치하지 않습니다.', 409, 'PAYMENT_MISMATCH');
    }
  }
  if (payment.approvedAt !== undefined && payment.approvedAt !== null && (typeof payment.approvedAt !== 'string' || payment.approvedAt.length > 64)) {
    throw new BillingError('결제 승인 시점을 확인할 수 없습니다.', 502, 'INVALID_PROVIDER_APPROVAL');
  }
  const approved = payment.approvedAt ? Date.parse(payment.approvedAt) : null;
  if ((payment.approvedAt && !Number.isFinite(approved)) || (['DONE', 'PARTIAL_CANCELED'].includes(payment.status) && approved === null)) {
    throw new BillingError('결제 승인 시점을 확인할 수 없습니다.', 502, 'INVALID_PROVIDER_APPROVAL');
  }
  return { canceled, approved, done, failed, paid: ['DONE', 'CANCELED', 'PARTIAL_CANCELED'].includes(payment.status) && approved !== null };
}
async function ownedOrder(sql: D1Database, owner: string, id: unknown): Promise<PaymentRow> {
  if (!validOrderId(id)) throw new BillingError('주문을 찾을 수 없습니다.', 404, 'PAYMENT_NOT_FOUND');
  const order = await sql.prepare('SELECT * FROM payments WHERE id=? AND user_id=?').bind(id, owner).first<PaymentRow>();
  if (!order) throw new BillingError('주문을 찾을 수 없습니다.', 404, 'PAYMENT_NOT_FOUND');
  return order;
}
export async function paymentStatus(sql: D1Database, owner: string, orderId: string): Promise<PaymentStatus> {
  const order = await ownedOrder(sql, owner, orderId);
  const pending = await sql.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM payment_refunds WHERE payment_id=? AND status IN ('pending','review')").bind(order.id).first<{ amount: number }>();
  return {
    ok: true, orderId: order.id, orderName: order.order_name || 'Prism AI 크레딧', productId: order.product_id,
    amount: order.amount, currency: 'KRW', mode: order.mode, status: order.status,
    refundedAmount: order.refunded_amount, pendingRefundAmount: pending?.amount || 0, balance: await balance(sql, owner, order.mode),
    createdAt: order.created_at, paidAt: order.paid_at, canReconcile: keyInfo(env.TOSS_SECRET_KEY, 'sk')?.mode === order.mode,
  };
}
export async function billingOverview(sql: D1Database, owner: string) {
  const config = await getBillingConfig(sql), overview = await upgradeOverview(sql, owner);
  return {
    ...overview, topUps: TOP_UPS, rates: config.rates, refundPolicy: config.refundPolicy, validityPolicy: config.validityPolicy,
    blockers: launchBlockers(config),
    events: (await sql.prepare('SELECT kind,amount,mode,reference,created_at FROM wallet_events WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(owner).all()).results,
    payments: (await sql.prepare('SELECT id,amount,mode,status,created_at,product_id,order_name,refunded_amount,paid_at,last_error FROM payments WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(owner).all()).results,
    refunds: (await sql.prepare('SELECT r.id,r.payment_id,r.request_id,r.amount,r.status,r.created_at,r.updated_at,r.last_error FROM payment_refunds r JOIN payments p ON p.id=r.payment_id WHERE p.user_id=? ORDER BY r.created_at DESC LIMIT 50').bind(owner).all()).results,
  };
}

function releaseRefundStatements(sql: D1Database, order: PaymentRow): D1PreparedStatement[] {
  const now = Date.now();
  const statements = [sql.prepare(`INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at)
    SELECT lower(hex(randomblob(16))),p.user_id,p.mode,'refund_release',r.amount*1000000,'refund-release:'||r.id,?
    FROM payment_refunds r JOIN payments p ON p.id=r.payment_id
    WHERE p.id=? AND r.status IN ('succeeded','failed')
    AND EXISTS (SELECT 1 FROM wallet_events WHERE reference='refund-reserve:'||r.id)
    ON CONFLICT(reference) DO NOTHING`).bind(now, order.id)];
  if (order.mode === 'live') {
    statements.push(sql.prepare(`INSERT INTO account_flags (user_id,reason,created_at)
      SELECT ?,'payment_refund_balance',? WHERE (SELECT COALESCE(SUM(amount),0) FROM wallet_events WHERE user_id=? AND mode='live')<0
      ON CONFLICT(user_id) DO UPDATE SET reason=excluded.reason
      WHERE account_flags.reason IN ('payment_refund_balance','payment_reconciliation')`).bind(order.user_id, now, order.user_id));
    statements.push(sql.prepare(`DELETE FROM account_flags WHERE user_id=? AND reason IN ('payment_refund_balance','payment_reconciliation')
      AND (SELECT COALESCE(SUM(amount),0) FROM wallet_events WHERE user_id=? AND mode='live')>=0
      AND NOT EXISTS (SELECT 1 FROM payments WHERE user_id=? AND mode='live' AND status='review')
      AND NOT EXISTS (SELECT 1 FROM payment_refunds r JOIN payments p ON p.id=r.payment_id WHERE p.user_id=? AND p.mode='live' AND r.status='review')`)
      .bind(order.user_id, order.user_id, order.user_id, order.user_id));
  }
  return statements;
}
/** Only call with a response fetched from Toss using the order's secret key.
 * A webhook's data is never passed directly to this function. */
async function applyPaymentSnapshot(sql: D1Database, order: PaymentRow, payment: ProviderPayment, expectedKey?: string) {
  const verified = validateSnapshot(order, payment, expectedKey), now = Date.now();
  try {
    await sql.prepare('UPDATE payments SET payment_key=?,candidate_payment_key=NULL WHERE id=? AND (payment_key IS NULL OR payment_key=?)')
      .bind(payment.paymentKey, order.id, payment.paymentKey).run();
  } catch { throw new BillingError('이미 다른 주문에 연결된 결제입니다.', 409, 'PAYMENT_KEY_CONFLICT'); }
  const claimed = await sql.prepare('SELECT payment_key FROM payments WHERE id=?').bind(order.id).first<{ payment_key: string }>();
  if (claimed?.payment_key !== payment.paymentKey) throw new BillingError('이미 다른 결제가 연결된 주문입니다.', 409, 'PAYMENT_KEY_CONFLICT');
  const paid = verified.paid;
  const statements: D1PreparedStatement[] = [];
  if (paid) {
    // Credit the approved gross amount even when the first observed snapshot is
    // already partially refunded; then debit the verified cumulative refund in
    // the same atomic D1 batch. This also recovers a lost confirmation response.
    statements.push(sql.prepare(`INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at)
      SELECT ?,user_id,mode,'topup',amount*1000000,?,? FROM payments WHERE id=?
      ON CONFLICT(reference) DO NOTHING`).bind(crypto.randomUUID(), 'payment:' + order.id, now, order.id));
    if (verified.canceled > 0) {
      statements.push(sql.prepare(`INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at)
        SELECT ?,user_id,mode,'refund',-(?-refunded_amount)*1000000,?,? FROM payments WHERE id=? AND refunded_amount<?
        ON CONFLICT(reference) DO NOTHING`).bind(crypto.randomUUID(), verified.canceled, 'refund:' + order.id + ':' + verified.canceled, now, order.id, verified.canceled));
    }
    statements.push(sql.prepare(`UPDATE payments SET
      status=CASE WHEN last_error='PROVIDER_STATE_REVERSED' THEN 'review' WHEN MAX(refunded_amount,?)>=amount THEN 'refunded' WHEN MAX(refunded_amount,?)>0 THEN 'partially_refunded' ELSE 'paid' END,
      provider_status=CASE WHEN ?>=refunded_amount THEN ? ELSE provider_status END,
      refunded_amount=MAX(refunded_amount,?),paid_at=COALESCE(paid_at,?),updated_at=?,
      last_error=CASE WHEN last_error='PROVIDER_STATE_REVERSED' THEN last_error ELSE NULL END WHERE id=?`)
      .bind(verified.canceled, verified.canceled, verified.canceled, payment.status, verified.canceled, verified.approved, now, order.id));
  } else {
    // Test paid_at in the atomic write, not the stale pre-fetch object. A
    // concurrent approval must not hide a deposit reversal from this branch.
    // This exceptional review is sticky: a delayed older DONE response cannot
    // unfreeze a reversed deposit. An operator must review provider history.
    statements.push(sql.prepare(`UPDATE payments SET provider_status=?,updated_at=?,
      last_error=CASE WHEN paid_at IS NOT NULL THEN 'PROVIDER_STATE_REVERSED' ELSE last_error END,
      status=CASE WHEN paid_at IS NOT NULL THEN 'review' WHEN status='pending' AND ? IN ('ABORTED','CANCELED') THEN 'failed'
        WHEN status='pending' AND ?='EXPIRED' THEN 'expired' ELSE status END WHERE id=?`)
      .bind(payment.status, now, payment.status, payment.status, order.id));
    if (order.mode === 'live') statements.push(sql.prepare(`INSERT INTO account_flags (user_id,reason,created_at)
      SELECT user_id,'payment_reconciliation',? FROM payments WHERE id=? AND paid_at IS NOT NULL AND status='review'
      ON CONFLICT(user_id) DO UPDATE SET reason=excluded.reason
      WHERE account_flags.reason IN ('payment_reconciliation','payment_refund_balance')`).bind(now, order.id));
  }
  // Only unresolved local refund requests need state updates. Do not issue a
  // SQL statement for every historical provider cancellation on every webhook.
  const unresolved = (await sql.prepare("SELECT id,provider_cancel_key,amount FROM payment_refunds WHERE payment_id=? AND status IN ('pending','review') AND provider_cancel_key IS NOT NULL")
    .bind(order.id).all<{ id: string; provider_cancel_key: string; amount: number }>()).results;
  const byKey = new Map((payment.cancels || []).map(cancel => [cancel.transactionKey, cancel]));
  for (const refund of unresolved) {
    const cancel = byKey.get(refund.provider_cancel_key);
    if (cancel && cancel.cancelStatus !== 'IN_PROGRESS' && cancel.cancelAmount === refund.amount) {
      const state = cancel.cancelStatus === 'FAILED' ? 'failed' : 'succeeded';
      statements.push(sql.prepare(`UPDATE payment_refunds SET status=?,completed_at=?,updated_at=?,last_error=NULL
        WHERE id=? AND provider_cancel_key=? AND amount=? AND status IN ('pending','review')`)
        .bind(state, now, now, refund.id, cancel.transactionKey, cancel.cancelAmount));
    }
  }
  statements.push(...releaseRefundStatements(sql, order));
  await sql.batch(statements);
}
export async function creditPayment(sql: D1Database, payment: ProviderPayment) {
  if (!validOrderId(payment?.orderId)) throw new BillingError('주문을 찾을 수 없습니다.', 404, 'PAYMENT_NOT_FOUND');
  const order = await sql.prepare('SELECT * FROM payments WHERE id=?').bind(payment.orderId).first<PaymentRow>();
  if (!order || payment.status !== 'DONE') throw new BillingError('승인된 결제를 찾을 수 없습니다.', 409, 'PAYMENT_MISMATCH');
  await applyPaymentSnapshot(sql, order, payment);
}
async function orderResponse(order: PaymentRow): Promise<PaymentOrder> {
  const keys = checkoutCredentials();
  if (!keys || keys.mode !== order.mode) throw new BillingError('결제 연결을 다시 확인해 주세요.', 503, 'PAYMENT_ENVIRONMENT_UNAVAILABLE');
  return {
    orderId: order.id, orderName: order.order_name || 'Prism AI 크레딧', productId: order.product_id!, amount: order.amount,
    currency: 'KRW', mode: order.mode, clientKey: env.TOSS_CLIENT_KEY!,
    customerKey: 'prism_' + (await digest(order.mode + ':' + order.user_id)).slice(0, 40), checkoutKind: keys.kind,
  };
}
async function createOrder(req: Request, sql: D1Database, owner: string, body: Record<string, unknown>): Promise<PaymentOrder> {
  const config = await getBillingConfig(sql), mode = paymentMode(config);
  if (mode === 'disabled') throw new BillingError('결제 서비스를 준비하고 있습니다. 실제 금액은 청구되지 않습니다.', 503, 'PAYMENTS_DISABLED');
  onlyKeys(body, ['productId', 'requestId', 'consent']);
  const product = BILLING_PRODUCTS.find(item => item.id === body.productId), idempotency = requestId(body.requestId);
  if (!product) throw new BillingError('판매 중인 크레딧 상품을 선택해 주세요.', 400, 'INVALID_PRODUCT');
  if (!record(body.consent) || body.consent.accepted !== true || typeof body.consent.version !== 'string' || typeof body.consent.policyHash !== 'string') {
    throw new BillingError('구매 조건을 확인하고 동의해 주세요.', 400, 'CONSENT_REQUIRED');
  }
  onlyKeys(body.consent, ['accepted', 'version', 'policyHash']);
  const consent = body.consent;
  const existing = await sql.prepare('SELECT * FROM payments WHERE user_id=? AND mode=? AND checkout_request_id=?').bind(owner, mode, idempotency).first<PaymentRow>();
  if (existing) {
    if (existing.product_id !== product.id || existing.terms_version !== consent.version || existing.terms_hash !== consent.policyHash) throw new BillingError('같은 요청 식별자로 구매 조건을 바꿀 수 없습니다.', 409, 'ORDER_IDEMPOTENCY_CONFLICT');
    if (existing.status !== 'pending' || (existing.expires_at || 0) <= Date.now()) throw new BillingError('기존 주문의 결제 내역을 먼저 확인해 주세요.', 409, 'ORDER_ALREADY_CREATED');
    return orderResponse(existing);
  }
  const terms = await termsFor(config);
  if (consent.version !== terms.version || consent.policyHash !== terms.policyHash) throw new BillingError('구매 조건이 변경되었습니다. 새로 표시된 조건을 확인해 주세요.', 409, 'TERMS_CHANGED');
  await throttle(sql, 'billing:orders:' + owner, 15, 60 * 60 * 1000);
  const now = Date.now(), id = 'prism_' + crypto.randomUUID().replaceAll('-', '');
  const snapshot = JSON.stringify({ ...terms, business: business(config), rates: config.rates, product, accepted: true });
  await sql.prepare(`INSERT INTO payments
    (id,user_id,amount,mode,status,created_at,product_id,order_name,product_snapshot,checkout_request_id,currency,
     terms_version,terms_hash,consent_snapshot,consented_at,expires_at,updated_at)
    SELECT ?,?,?,?,'pending',?,?,?,?,?,'KRW',?,?,?,?,?,?
    WHERE (SELECT COUNT(*) FROM payments WHERE user_id=? AND status='pending' AND expires_at>?)<10
    ON CONFLICT(user_id,mode,checkout_request_id) DO NOTHING`)
    .bind(id, owner, product.amount, mode, now, product.id, product.name, JSON.stringify(product), idempotency,
      terms.version, terms.policyHash, snapshot, now, now + ORDER_LIFETIME_MS, now, owner, now).run();
  const saved = await sql.prepare('SELECT * FROM payments WHERE user_id=? AND mode=? AND checkout_request_id=?').bind(owner, mode, idempotency).first<PaymentRow>();
  if (!saved) throw new BillingError('진행 중인 결제 주문을 먼저 확인해 주세요.', 429, 'TOO_MANY_PENDING_ORDERS');
  if (saved.product_id !== product.id || saved.terms_hash !== terms.policyHash || saved.terms_version !== terms.version) throw new BillingError('같은 요청 식별자의 구매 조건이 다릅니다.', 409, 'ORDER_IDEMPOTENCY_CONFLICT');
  return orderResponse(saved);
}
async function clearCandidate(sql: D1Database, orderId: string, key: string) {
  await sql.prepare('UPDATE payments SET candidate_payment_key=NULL WHERE id=? AND candidate_payment_key=? AND payment_key IS NULL').bind(orderId, key).run();
}
async function confirmOrder(sql: D1Database, order: PaymentRow, key: string): Promise<PaymentStatus> {
  secretFor(order.mode);
  if (order.payment_key && order.payment_key !== key) throw new BillingError('다른 결제키가 연결된 주문입니다.', 409, 'PAYMENT_KEY_CONFLICT');
  await throttle(sql, 'billing:confirm:' + order.id, 30, 60_000);
  // A candidate is private recovery metadata, NOT a unique trusted binding. A
  // malicious mismatched callback therefore cannot occupy another order's key.
  await sql.prepare('UPDATE payments SET candidate_payment_key=? WHERE id=? AND payment_key IS NULL').bind(key, order.id).run();
  let payment: ProviderPayment | undefined;
  try {
    try { payment = await toss(order.mode, '/' + encodeURIComponent(key)); }
    catch (error) { if (!notFound(error)) throw error; }
    if (payment) {
      validateSnapshot(order, payment, key);
      if (order.paid_at !== null || ['DONE', 'CANCELED', 'PARTIAL_CANCELED', 'WAITING_FOR_DEPOSIT', 'ABORTED', 'EXPIRED'].includes(payment.status)) {
        await applyPaymentSnapshot(sql, order, payment, key);
        return paymentStatus(sql, order.user_id, order.id);
      }
    }
    if (order.status !== 'pending' || (order.expires_at !== null && order.expires_at <= Date.now())) {
      await sql.prepare("UPDATE payments SET status='expired',updated_at=? WHERE id=? AND status='pending'").bind(Date.now(), order.id).run();
      throw new BillingError('이 주문은 새 결제 승인을 진행할 수 없습니다. 결제 내역을 다시 확인해 주세요.', 409, 'ORDER_NOT_PAYABLE');
    }
    try {
      // Invalid callback keys must not poison a legitimate key's cached
      // approval response. The exact attempt remains idempotent across retries.
      payment = await toss(order.mode, '/confirm', 'POST', { paymentKey: key, orderId: order.id, amount: order.amount }, 'confirm:' + order.id + ':' + (await digest(key)).slice(0, 32));
    } catch (error) {
      // A timeout/5xx/duplicate-confirm response is not proof of payment
      // failure. Recover through the same provider key before reporting it.
      try {
        const recovered = await toss(order.mode, '/' + encodeURIComponent(key));
        validateSnapshot(order, recovered, key);
        if (['DONE', 'CANCELED', 'PARTIAL_CANCELED', 'WAITING_FOR_DEPOSIT'].includes(recovered.status)) {
          await applyPaymentSnapshot(sql, order, recovered, key);
          return paymentStatus(sql, order.user_id, order.id);
        }
      } catch (recoveryError) {
        if (recoveryError instanceof BillingError && recoveryError.code === 'PAYMENT_MISMATCH') { await clearCandidate(sql, order.id, key); throw recoveryError; }
      }
      if (error instanceof TossFailure && error.definitive) await clearCandidate(sql, order.id, key);
      throw error;
    }
    await applyPaymentSnapshot(sql, order, payment, key);
    return paymentStatus(sql, order.user_id, order.id);
  } catch (error) {
    if (error instanceof BillingError && ['PAYMENT_MISMATCH', 'PAYMENT_KEY_CONFLICT'].includes(error.code)) await clearCandidate(sql, order.id, key);
    const code = error instanceof TossFailure ? error.providerCode : error instanceof BillingError ? error.code : 'PAYMENT_CHECK_FAILED';
    await sql.prepare("UPDATE payments SET last_error=?,updated_at=? WHERE id=? AND status='pending'").bind(code, Date.now(), order.id).run();
    throw error;
  }
}
async function reconcileOrder(sql: D1Database, order: PaymentRow): Promise<PaymentStatus> {
  secretFor(order.mode);
  const knownKey = order.payment_key || order.candidate_payment_key;
  if (knownKey) return confirmOrder(sql, order, knownKey);
  // Toss's orderId lookup accepts individual API secrets (sk), not widget
  // secrets (gsk). Never substitute a widget key or imply recovery succeeded.
  if (keyInfo(env.TOSS_SECRET_KEY, 'sk')?.family === 'g') throw new BillingError('결제 결과 주소가 필요합니다. 결제를 진행한 탭에서 다시 확인하거나 주문번호로 고객지원에 문의해 주세요.', 409, 'PAYMENT_KEY_REQUIRED');
  await throttle(sql, 'billing:reconcile:' + order.id, 20, 60_000);
  let payment: ProviderPayment;
  try { payment = await toss(order.mode, '/orders/' + encodeURIComponent(order.id)); }
  catch (error) { if (notFound(error)) return paymentStatus(sql, order.user_id, order.id); throw error; }
  validateSnapshot(order, payment);
  if (payment.status === 'IN_PROGRESS' && order.consented_at) return confirmOrder(sql, order, payment.paymentKey);
  await applyPaymentSnapshot(sql, order, payment);
  return paymentStatus(sql, order.user_id, order.id);
}
export async function paymentRequest(req: Request, sql: D1Database, owner: string, path: string[]) {
  if (req.method !== 'POST' || path.length !== 2 || !['orders', 'confirm', 'reconcile'].includes(path[1])) throw new BillingError('결제 경로를 찾을 수 없습니다.', 404, 'PAYMENT_ENDPOINT_NOT_FOUND');
  const body = parseBody(await requestText(req));
  if (path[1] === 'orders') return createOrder(req, sql, owner, body);
  if (path[1] === 'confirm') {
    onlyKeys(body, ['orderId', 'paymentKey', 'amount']);
    if (!validPaymentKey(body.paymentKey) || !Number.isSafeInteger(body.amount)) throw new BillingError('결제 확인 값이 올바르지 않습니다.', 400, 'INVALID_PAYMENT_INPUT');
    const order = await ownedOrder(sql, owner, body.orderId);
    if (order.amount !== body.amount) throw new BillingError('결제 금액이 주문과 일치하지 않습니다.', 409, 'PAYMENT_MISMATCH');
    return confirmOrder(sql, order, body.paymentKey);
  }
  onlyKeys(body, ['orderId']);
  return reconcileOrder(sql, await ownedOrder(sql, owner, body.orderId));
}

async function refundResult(sql: D1Database, order: PaymentRow, refund: RefundRow) {
  const current = await sql.prepare('SELECT status FROM payment_refunds WHERE id=?').bind(refund.id).first<{ status: RefundRow['status'] }>();
  return { ...await paymentStatus(sql, order.user_id, order.id), refundRequestId: refund.request_id, refundStatus: current?.status || refund.status };
}
/** Caller MUST require the configured administrator identity. A refund keeps
 * a durable wallet reservation until provider success or verified rejection. */
export async function adminCancelPayment(req: Request, sql: D1Database) {
  const body = parseBody(await requestText(req));
  onlyKeys(body, ['orderId', 'amount', 'reason', 'requestId']);
  if (!validOrderId(body.orderId) || !Number.isSafeInteger(body.amount) || (body.amount as number) <= 0 ||
      typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 200) {
    throw new BillingError('주문번호, 환불 금액, 사유를 확인해 주세요.', 400, 'INVALID_REFUND_INPUT');
  }
  const idempotency = requestId(body.requestId), amount = body.amount as number, reason = body.reason.trim();
  let order = await sql.prepare('SELECT * FROM payments WHERE id=?').bind(body.orderId).first<PaymentRow>();
  if (!order) throw new BillingError('주문을 찾을 수 없습니다.', 404, 'PAYMENT_NOT_FOUND');
  let refund = await sql.prepare('SELECT * FROM payment_refunds WHERE request_id=?').bind(idempotency).first<RefundRow>();
  if (refund && (refund.payment_id !== order.id || refund.amount !== amount || refund.reason !== reason)) throw new BillingError('같은 환불 요청 식별자의 내용이 다릅니다.', 409, 'REFUND_IDEMPOTENCY_CONFLICT');
  if (refund && (refund.status === 'succeeded' || refund.status === 'failed')) return refundResult(sql, order, refund);
  // Toss scopes idempotency to the API key. Retrying with a rotated key can
  // execute the same cancellation again, even when its request ID is unchanged.
  // Store only a one-way fingerprint, never the secret or any recoverable key.
  const providerIdempotency = 'cancel:v1:' + idempotency + ':' + await digest(secretFor(order.mode));
  if (!refund) {
    if (!order.payment_key || !['paid', 'partially_refunded'].includes(order.status)) throw new BillingError('승인된 결제만 환불할 수 있습니다. 주문을 먼저 확인해 주세요.', 409, 'PAYMENT_NOT_REFUNDABLE');
    await throttle(sql, 'billing:refund:' + order.id, 10, 60_000);
    const before = await toss(order.mode, '/' + encodeURIComponent(order.payment_key));
    await applyPaymentSnapshot(sql, order, before, order.payment_key);
    order = (await sql.prepare('SELECT * FROM payments WHERE id=?').bind(order.id).first<PaymentRow>())!;
    const now = Date.now(), id = 'refund_' + crypto.randomUUID().replaceAll('-', '');
    await sql.batch([
      sql.prepare(`INSERT INTO payment_refunds
        (id,payment_id,request_id,amount,baseline_refunded,reason,status,idempotency_key,created_at,updated_at)
        SELECT ?,p.id,?,?,p.refunded_amount,?,'pending',?,?,? FROM payments p
        WHERE p.id=? AND p.status IN ('paid','partially_refunded') AND p.refunded_amount+?<=p.amount
        AND NOT EXISTS (SELECT 1 FROM payment_refunds r WHERE r.payment_id=p.id AND r.status IN ('pending','review'))
        AND (SELECT COALESCE(SUM(w.amount),0) FROM wallet_events w WHERE w.user_id=p.user_id AND w.mode=p.mode)>=?*1000000
        AND (p.mode='test' OR NOT EXISTS (SELECT 1 FROM account_flags WHERE user_id=p.user_id))
        ON CONFLICT(request_id) DO NOTHING`)
        .bind(id, idempotency, amount, reason, providerIdempotency, now, now, order.id, amount, amount),
      sql.prepare(`INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at)
        SELECT ?,p.user_id,p.mode,'refund_reserve',-r.amount*1000000,'refund-reserve:'||r.id,?
        FROM payment_refunds r JOIN payments p ON p.id=r.payment_id WHERE r.request_id=? AND r.status='pending'
        ON CONFLICT(reference) DO NOTHING`).bind(crypto.randomUUID(), now, idempotency),
    ]);
    refund = await sql.prepare('SELECT * FROM payment_refunds WHERE request_id=?').bind(idempotency).first<RefundRow>();
    if (!refund) throw new BillingError('미사용 잔액, 남은 환불 가능 금액 또는 진행 중인 환불을 확인해 주세요.', 409, 'REFUND_NOT_AVAILABLE');
    if (refund.payment_id !== order.id || refund.amount !== amount || refund.reason !== reason) throw new BillingError('같은 환불 요청 식별자의 내용이 다릅니다.', 409, 'REFUND_IDEMPOTENCY_CONFLICT');
  }
  if (refund.status === 'succeeded' || refund.status === 'failed') return refundResult(sql, order, refund);
  if (refund.idempotency_key !== providerIdempotency) {
    await sql.prepare("UPDATE payment_refunds SET status='review',last_error='REFUND_KEY_CHANGED',updated_at=? WHERE id=? AND status='pending'")
      .bind(Date.now(), refund.id).run();
    throw new BillingError('결제키가 변경되어 자동 환불 재시도를 중지했습니다. 원래 결제 환경과 제공사 환불 내역을 확인해 주세요.', 409, 'REFUND_KEY_CHANGED');
  }
  if (refund.status === 'review' || refund.created_at + REFUND_RETRY_MS <= Date.now()) {
    await sql.prepare("UPDATE payment_refunds SET status='review',last_error='IDEMPOTENCY_WINDOW_EXPIRED',updated_at=? WHERE id=? AND status='pending'").bind(Date.now(), refund.id).run();
    throw new BillingError('이 환불은 제공사 내역을 확인한 뒤 수동 정산해야 합니다. 자동으로 재청구하지 않습니다.', 409, 'REFUND_REVIEW_REQUIRED');
  }
  const token = crypto.randomUUID(), now = Date.now();
  const locked = await sql.prepare(`UPDATE payment_refunds SET lock_token=?,locked_until=?,updated_at=?
    WHERE id=? AND status='pending' AND (locked_until IS NULL OR locked_until<=?) RETURNING id`)
    .bind(token, now + 60_000, now, refund.id, now).first();
  if (!locked) throw new BillingError('같은 환불을 확인하고 있습니다. 잠시 후 다시 확인해 주세요.', 409, 'REFUND_IN_PROGRESS');
  const currentOrder = order;
  try {
    if (!currentOrder.payment_key) throw new BillingError('승인된 결제키가 없습니다.', 409, 'PAYMENT_NOT_REFUNDABLE');
    await sql.prepare('UPDATE payment_refunds SET submitted_at=COALESCE(submitted_at,?),updated_at=? WHERE id=? AND lock_token=?')
      .bind(Date.now(), Date.now(), refund.id, token).run();
    // Retrying uses this same persisted idempotency key, including after an
    // HTTP response is lost. Never create a replacement refund on timeout.
    const payment = await toss(currentOrder.mode, '/' + encodeURIComponent(currentOrder.payment_key) + '/cancel', 'POST',
      { cancelReason: reason, cancelAmount: amount }, refund.idempotency_key);
    const checked = validateSnapshot(currentOrder, payment, currentOrder.payment_key);
    const cancellation = payment.cancels?.find(item => item.transactionKey === payment.lastTransactionKey);
    if (!cancellation || cancellation.cancelAmount !== amount ||
        (cancellation.cancelStatus !== 'IN_PROGRESS' && cancellation.cancelStatus !== 'FAILED' && checked.canceled < refund.baseline_refunded + amount)) {
      throw new BillingError('환불 결과를 확정할 수 없습니다. 같은 환불 요청을 다시 확인해 주세요.', 502, 'REFUND_RESULT_UNCERTAIN');
    }
    await sql.prepare('UPDATE payment_refunds SET provider_cancel_key=?,updated_at=? WHERE id=? AND lock_token=?')
      .bind(cancellation.transactionKey, Date.now(), refund.id, token).run();
    await applyPaymentSnapshot(sql, currentOrder, payment, currentOrder.payment_key);
    return refundResult(sql, currentOrder, refund);
  } catch (error) {
    const code = error instanceof TossFailure ? error.providerCode : error instanceof BillingError ? error.code : 'REFUND_UNCERTAIN';
    let reconciled = false;
    // A verified snapshot must be applied before releasing a rejected refund's
    // reservation; otherwise a prior successful cancel with a lost response
    // could leave spendable credits for money already returned to the buyer.
    try {
      if (currentOrder.payment_key) {
        const payment = await toss(currentOrder.mode, '/' + encodeURIComponent(currentOrder.payment_key));
        await applyPaymentSnapshot(sql, currentOrder, payment, currentOrder.payment_key);
        reconciled = true;
      }
    } catch { /* Keep the reservation. The same durable request can be retried. */ }
    if (error instanceof TossFailure && error.definitive && reconciled) {
      await sql.batch([
        sql.prepare("UPDATE payment_refunds SET status='failed',last_error=?,completed_at=?,updated_at=? WHERE id=? AND status='pending'")
          .bind(code, Date.now(), Date.now(), refund.id),
        ...releaseRefundStatements(sql, currentOrder),
      ]);
    } else {
      await sql.prepare("UPDATE payment_refunds SET last_error=?,updated_at=? WHERE id=? AND status='pending'").bind(code, Date.now(), refund.id).run();
    }
    throw error;
  } finally {
    await sql.prepare('UPDATE payment_refunds SET lock_token=NULL,locked_until=NULL WHERE id=? AND lock_token=?').bind(refund.id, token).run();
  }
}

async function validateWebhookSignature(req: Request, payload: string) {
  const securityKey = env.TOSS_WEBHOOK_SECURITY_KEY;
  if (!securityKey) return;
  if (!/^(?:[a-f0-9]{2}){16,128}$/i.test(securityKey)) throw new BillingError('웹훅 검증 설정을 확인해 주세요.', 503, 'WEBHOOK_KEY_INVALID');
  const transmission = req.headers.get('tosspayments-webhook-transmission-time');
  const signatures = req.headers.get('tosspayments-webhook-signature');
  if (!transmission || transmission.length > 128 || /[\u0000-\u001f\u007f]/.test(transmission) || !signatures || signatures.length > 8192) {
    throw new BillingError('웹훅 서명을 확인할 수 없습니다.', 401, 'WEBHOOK_SIGNATURE_INVALID');
  }
  const bytes = Uint8Array.from(securityKey.match(/../g)!, pair => parseInt(pair, 16));
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const message = new TextEncoder().encode(payload + ':' + transmission);
  for (const candidate of signatures.split(',')) {
    const match = /^v1:([A-Za-z0-9+/]+={0,2})$/.exec(candidate.trim());
    if (!match) continue;
    try {
      const signature = Uint8Array.from(atob(match[1]), character => character.charCodeAt(0));
      if (signature.length === 32 && await crypto.subtle.verify('HMAC', key, signature, message)) return;
    } catch { /* Try the other documented signature versions/rotation entries. */ }
  }
  throw new BillingError('웹훅 서명이 올바르지 않습니다.', 401, 'WEBHOOK_SIGNATURE_INVALID');
}
async function sameSecret(left: string, right: string) {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
export async function paymentWebhook(req: Request, sql: D1Database) {
  const raw = await requestText(req, 65_536);
  await validateWebhookSignature(req, raw);
  const body = parseBody(raw);
  // Deposit callbacks have a documented top-level shape without eventType.
  const deposit = body.eventType === 'DEPOSIT_CALLBACK' || (body.eventType === undefined && validOrderId(body.orderId) && typeof body.secret === 'string');
  if (!deposit && !['PAYMENT_STATUS_CHANGED', 'CANCEL_STATUS_CHANGED'].includes(String(body.eventType))) return { ok: true, ignored: true };
  const data = deposit ? (record(body.data) ? body.data : body) : body.data;
  if (!record(data)) throw new BillingError('웹훅 본문이 올바르지 않습니다.', 400, 'INVALID_WEBHOOK');
  const suppliedKey = data.paymentKey;
  if (suppliedKey !== undefined && suppliedKey !== null && !validPaymentKey(suppliedKey)) throw new BillingError('웹훅 결제키가 올바르지 않습니다.', 400, 'INVALID_WEBHOOK');
  let order = validPaymentKey(suppliedKey)
    ? await sql.prepare('SELECT * FROM payments WHERE payment_key=?').bind(suppliedKey).first<PaymentRow>() : null;
  if (!order && validOrderId(data.orderId)) order = await sql.prepare('SELECT * FROM payments WHERE id=?').bind(data.orderId).first<PaymentRow>();
  if (!order && body.eventType === 'CANCEL_STATUS_CHANGED' && validPaymentKey(data.transactionKey)) {
    order = await sql.prepare('SELECT p.* FROM payments p JOIN payment_refunds r ON r.payment_id=p.id WHERE r.provider_cancel_key=?').bind(data.transactionKey).first<PaymentRow>();
  }
  // Unknown merchant orders cannot trigger network requests or reveal customer
  // information. They may belong to another integration sharing this endpoint.
  if (!order) return { ok: true, ignored: true };
  secretFor(order.mode);
  await throttle(sql, 'billing:webhook:' + order.id, 30, 60_000);
  const key = validPaymentKey(suppliedKey) ? suppliedKey : order.payment_key;
  let payment: ProviderPayment;
  if (key) payment = await toss(order.mode, '/' + encodeURIComponent(key));
  else if (keyInfo(env.TOSS_SECRET_KEY, 'sk')?.family !== 'g') payment = await toss(order.mode, '/orders/' + encodeURIComponent(order.id));
  else throw new BillingError('원래 결제의 확인을 기다리고 있습니다.', 503, 'PAYMENT_KEY_REQUIRED');
  validateSnapshot(order, payment, key || undefined);
  if (deposit) {
    const providerSecret = (payment as ProviderPayment & { secret?: unknown }).secret;
    if (typeof data.secret !== 'string' || data.secret.length > 200 || typeof providerSecret !== 'string' || !providerSecret || !await sameSecret(data.secret, providerSecret)) {
      throw new BillingError('입금 웹훅을 검증할 수 없습니다.', 401, 'WEBHOOK_SECRET_INVALID');
    }
  }
  // This endpoint NEVER approves an IN_PROGRESS payment. It reconciles only
  // the authoritative current state, independently of spoofable payload fields.
  await applyPaymentSnapshot(sql, order, payment, key || undefined);
  return { ok: true };
}
