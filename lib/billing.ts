import { env } from 'cloudflare:workers';
import { MODELS } from './models';

// One unit is 1/1,000,000 KRW. All ledger arithmetic uses safe integers.
export const WON = 1_000_000;
export const TOP_UPS = [10_000, 30_000, 50_000];
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
  constructor(message: string, public status = 400) { super(message); }
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
  const row = await sql.prepare("SELECT value FROM billing_config WHERE key='launch'").first<{value:string}>();
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
export function paymentMode(config: BillingConfig): 'disabled'|'test'|'live' {
  const mode = env.PAYMENTS_MODE;
  if (mode === 'test' && /^test_(g)?sk_/.test(env.TOSS_SECRET_KEY || '') && /^test_(g)?ck_/.test(env.TOSS_CLIENT_KEY || '')) return 'test';
  if (mode === 'live' && env.LAUNCH_APPROVED === 'true' && !launchBlockers(config).length && /^live_(g)?sk_/.test(env.TOSS_SECRET_KEY || '') && /^live_(g)?ck_/.test(env.TOSS_CLIENT_KEY || '')) return 'live';
  return 'disabled';
}
export async function balance(sql: D1Database, owner: string, mode = 'live'): Promise<number> {
  const row = await sql.prepare('SELECT COALESCE(SUM(amount),0) AS balance FROM wallet_events WHERE user_id=? AND mode=?').bind(owner, mode).first<{balance:number}>();
  return row?.balance || 0;
}
export async function reserve(sql: D1Database, owner: string, requestId: string, amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new BillingError('요청 비용을 계산할 수 없습니다.');
  // The balance predicate and debit run as one SQLite write statement, across
  // all conversations and Workers. No read-then-update race can overspend.
  const row = await sql.prepare(`INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at)
    SELECT ?,?,'live','reserve',?,?,? WHERE
    (SELECT COALESCE(SUM(amount),0) FROM wallet_events WHERE user_id=? AND mode='live') >= ?
    AND NOT EXISTS (SELECT 1 FROM account_flags WHERE user_id=?)
    AND (SELECT COUNT(*) FROM wallet_events r WHERE r.user_id=? AND r.kind='reserve'
      AND NOT EXISTS (SELECT 1 FROM wallet_events s WHERE s.reference='settle:' || substr(r.reference,9))) < 3
    RETURNING id`).bind(crypto.randomUUID(),owner,-amount,'reserve:'+requestId,Date.now(),owner,amount,owner,owner).first();
  if (!row) throw new BillingError('사용 가능 잔액이 부족하거나 정산 대기 요청이 3개 있습니다. 충전 내역을 확인하세요.', 402);
}
export async function settle(sql: D1Database, owner: string, requestId: string, reserved: number, charge: number) {
  if (!Number.isSafeInteger(charge) || charge < 0 || charge > reserved) throw new BillingError('사용량 확인이 필요해 예약 잔액을 보류했습니다.', 503);
  await sql.prepare(`INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at)
    SELECT ?,?,'live','settle',?,?,? WHERE EXISTS
    (SELECT 1 FROM wallet_events WHERE user_id=? AND reference=? AND amount=?)
    ON CONFLICT(reference) DO NOTHING`).bind(crypto.randomUUID(),owner,reserved-charge,'settle:'+requestId,Date.now(),owner,'reserve:'+requestId,-reserved).run();
  const applied=await sql.prepare('SELECT amount FROM wallet_events WHERE user_id=? AND reference=?').bind(owner,'settle:'+requestId).first<{amount:number}>();
  if(applied&&applied.amount!==reserved-charge)throw new BillingError('이미 다른 금액으로 정산된 요청입니다.',409);
}
export function cost(rate: Rates, input: number, output: number) {
  if (![input,output].every(n => Number.isSafeInteger(n) && n >= 0)) throw new BillingError('제공사 사용량을 검증하지 못했습니다.',503);
  const result = input * rate.input + output * rate.output;
  if (!Number.isSafeInteger(result)) throw new BillingError('사용량이 계산 범위를 초과했습니다.',503);
  return result;
}
export async function billingOverview(sql: D1Database, owner: string) {
  const config = await getBillingConfig(sql), mode = paymentMode(config);
  return { business: {name:'종합상사 루비',representative:'노휘석',registrationNumber:config.registrationNumber,address:config.address,supportEmail:config.supportEmail},
    topUps:TOP_UPS,mode,rates:config.rates,refundPolicy:config.refundPolicy,validityPolicy:config.validityPolicy,
    blockers:launchBlockers(config),balance:await balance(sql,owner),testBalance:await balance(sql,owner,'test'),
    events:(await sql.prepare('SELECT kind,amount,mode,reference,created_at FROM wallet_events WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(owner).all()).results,
    payments:(await sql.prepare('SELECT id,amount,mode,status,created_at FROM payments WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(owner).all()).results };
}
async function toss(path: string, method = 'GET', body?: unknown, idempotency?: string) {
  const response = await fetch('https://api.tosspayments.com/v1/payments'+path,{method,
    headers:{Authorization:'Basic '+btoa(env.TOSS_SECRET_KEY+':'),'Content-Type':'application/json',...(idempotency?{'Idempotency-Key':idempotency}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new BillingError('결제 제공사 확인에 실패했습니다. 같은 주문으로 다시 시도해주세요.',502);
  return response.json() as Promise<any>;
}
export async function creditPayment(sql: D1Database, payment: any) {
  const order = await sql.prepare('SELECT * FROM payments WHERE id=?').bind(payment.orderId).first<any>();
  if (!order || payment.status!=='DONE' || payment.currency!=='KRW' || payment.totalAmount!==order.amount || payment.balanceAmount!==order.amount || payment.paymentKey!==order.payment_key || (payment.cancels?.length || 0)>0) throw new BillingError('결제 금액 또는 상태가 주문과 일치하지 않습니다.',409);
  // Unique reference + atomic batch: callbacks and retries never credit twice.
  await sql.batch([
    sql.prepare("INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at) SELECT ?,user_id,mode,'topup',amount*1000000,?,? FROM payments WHERE id=? AND status IN ('pending','paid') ON CONFLICT(reference) DO NOTHING").bind(crypto.randomUUID(),'payment:'+order.id,Date.now(),order.id),
    sql.prepare("UPDATE payments SET status='paid' WHERE id=? AND status='pending'").bind(order.id),
  ]);
}
export async function paymentRequest(req: Request, sql: D1Database, owner: string, path: string[]) {
  const config = await getBillingConfig(sql), mode = paymentMode(config);
  if (mode==='disabled') throw new BillingError('결제 준비 중입니다. 실제 금액은 청구되지 않습니다.',503);
  const body = await req.json() as any;
  if (path[1]==='orders') {
    if (!TOP_UPS.includes(body.amount)) throw new BillingError('1만·3만·5만원 중 선택하세요.');
    const id = 'prism_'+crypto.randomUUID().replaceAll('-','');
    await sql.prepare("INSERT INTO payments (id,user_id,amount,mode,status,created_at) VALUES (?,?,?,?,'pending',?)").bind(id,owner,body.amount,mode,Date.now()).run();
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(owner));
    const customerKey='prism_'+Array.from(new Uint8Array(hash)).map(n=>n.toString(16).padStart(2,'0')).join('').slice(0,40);
    return {orderId:id,amount:body.amount,clientKey:env.TOSS_CLIENT_KEY,customerKey,mode};
  }
  if (path[1]==='confirm') {
    if (typeof body.orderId!=='string' || typeof body.paymentKey!=='string' || body.paymentKey.length>200 || !Number.isSafeInteger(body.amount)) throw new BillingError('결제 확인 값이 올바르지 않습니다.');
    const order = await sql.prepare('SELECT * FROM payments WHERE id=? AND user_id=? AND mode=?').bind(body.orderId,owner,mode).first<any>();
    if (!order) throw new BillingError('주문을 찾을 수 없습니다.',404);
    if (order.amount!==body.amount || (order.payment_key && order.payment_key!==body.paymentKey)) throw new BillingError('주문 금액 또는 결제키가 일치하지 않습니다.',409);
    await sql.prepare('UPDATE payments SET payment_key=? WHERE id=? AND (payment_key IS NULL OR payment_key=?)').bind(body.paymentKey,order.id,body.paymentKey).run();
    const claimed=await sql.prepare('SELECT payment_key FROM payments WHERE id=?').bind(order.id).first<{payment_key:string}>();
    if(claimed?.payment_key!==body.paymentKey) throw new BillingError('이미 다른 결제가 연결된 주문입니다.',409);
    // Reconcile first, including a previous successful confirmation whose HTTP response was lost.
    let payment: any;
    try {payment=await toss('/'+encodeURIComponent(body.paymentKey));} catch(e) {if(!(e instanceof BillingError))throw e;}
    if (payment?.status!=='DONE') payment=await toss('/confirm','POST',{paymentKey:body.paymentKey,orderId:order.id,amount:order.amount},'confirm:'+order.id);
    await creditPayment(sql,payment);
    return {ok:true,mode,balance:await balance(sql,owner,mode)};
  }
  throw new BillingError('결제 경로를 찾을 수 없습니다.',404);
}
export async function paymentWebhook(req: Request, sql: D1Database) {
  // Never trust webhook amounts/status. Fetch the payment using server credentials.
  const config=await getBillingConfig(sql), mode=paymentMode(config);
  if(mode==='disabled') throw new BillingError('결제가 비활성화되어 있습니다.',503);
  const body=await req.json() as any;
  const paymentKey=body.data?.paymentKey;
  if(typeof paymentKey!=='string' || paymentKey.length>200) throw new BillingError('결제키가 필요합니다.');
  const order=await sql.prepare('SELECT * FROM payments WHERE payment_key=? AND mode=?').bind(paymentKey,mode).first<any>();
  if(!order) throw new BillingError('주문을 찾을 수 없습니다.',404);
  const payment=await toss('/'+encodeURIComponent(paymentKey));
  if(payment.status==='DONE')await creditPayment(sql,payment);
  else if(['CANCELED','PARTIAL_CANCELED'].includes(payment.status)) {
    // An external cancellation must be reconciled before the wallet is usable.
    await sql.prepare("UPDATE payments SET status='review' WHERE id=?").bind(order.id).run();
    await sql.prepare('INSERT INTO account_flags (user_id,reason,created_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET reason=excluded.reason').bind(order.user_id,'payment_reconciliation',Date.now()).run();
  }
  return {ok:true};
}
