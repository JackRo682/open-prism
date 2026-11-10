'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MODELS } from '../lib/models';
import { notifyBillingUpdated, subscribeBillingUpdates } from '../lib/billing-sync';
import type { BillingProduct, PaymentMode } from '../lib/billing-contract';

type Rates = { input: number; output: number };
type Config = { rates: Record<string, Rates>; refundPolicy: string; validityPolicy: string; registrationNumber: string; address: string; supportEmail: string };
type Payment = { id: string; user_id?: string; amount: number; refunded_amount: number; mode: string; status: string; created_at: number; order_name?: string };
type RefundState = 'pending' | 'succeeded' | 'failed' | 'review';
type Refund = { id: string; payment_id: string; request_id: string; amount: number; reason?: string; status: RefundState; last_error?: string | null; created_at: number; updated_at?: number; mode?: string };
type RefundAttempt = { orderId: string; amount: number; reason: string; requestId: string; status: RefundState | 'uncertain' };
type RefundResult = { refundRequestId: string; refundStatus: RefundState };
type Overview = Config & {
  business: { name: string; representative: string; registrationNumber: string; address: string; supportEmail: string };
  products: BillingProduct[]; mode: PaymentMode; balance: number; testBalance: number; blockers: string[];
  payments: Payment[];
  refunds?: Refund[];
  events: { kind: string; amount: number; mode: string; reference: string; created_at: number }[];
};
const won = (amount: number) => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 }).format(amount) + '원';
const date = (timestamp: number) => new Date(timestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
const paymentLabels: Record<string, string> = { pending: '결제 대기', paid: '충전 완료', partially_refunded: '일부 환불', refunded: '환불 완료', expired: '기간 만료', failed: '결제 실패', review: '정산 확인 필요' };
const eventLabels: Record<string, string> = { topup: '충전', reserve: '요청 비용 예약', settle: '예약 차액 정산', refund: '환불', refund_reserve: '환불 금액 보류', refund_release: '환불 보류 해제' };
const refundLabels: Record<RefundState, string> = { pending: '환불 진행 중', succeeded: '환불 완료', failed: '환불 실패', review: '수동 확인 필요' };
const refundNotices: Record<RefundState, string> = {
  pending: '환불 결과를 확인하고 있습니다. 해당 금액은 확인이 끝날 때까지 보류됩니다. 새 환불을 만들지 말고 기존 요청을 다시 확인해 주세요.',
  succeeded: '환불 완료를 확인하고 크레딧에 반영했습니다.',
  failed: '이 환불 요청은 실패했습니다. 환불 완료 상태가 아닙니다. 잔액 변동 내역과 실패 사유를 확인해 주세요.',
  review: '이 환불은 수동 확인이 필요합니다. 환불 완료 상태가 아니며 확인 전까지 금액이 보류됩니다. 결제 제공사의 거래 내역을 확인해 주세요.',
};

async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 45_000);
  try {
    const response = await fetch('/api/' + path, {
      cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    let data: T & { error?: string };
    try { data = await response.json(); } catch { throw new Error('서버 응답을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    if (!response.ok) throw new Error(data.error || '요청을 완료하지 못했습니다.');
    return data;
  } catch (cause) {
    if (timedOut) throw new Error('응답 확인 시간이 초과되었습니다. 처리 결과는 확정되지 않았습니다. 기존 요청으로 다시 확인해 주세요.');
    throw cause;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

export default function BillingPanel({ admin = false, beta = false }: { admin?: boolean; beta?: boolean }) {
  const [data, setData] = useState<Overview | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refundOrder, setRefundOrder] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundConfirmed, setRefundConfirmed] = useState(false);
  const [refundAttempt, setRefundAttempt] = useState<RefundAttempt | null>(null);
  const refundAttemptRef = useRef<RefundAttempt | null>(null);
  const refundSubmitting = useRef(false);
  const mounted = useRef(true);
  const pendingRefresh = useRef<AbortController | null>(null);

  const applyRefundOutcome = useCallback((requestId: string, status: RefundState) => {
    const attempt = refundAttemptRef.current;
    if (!attempt || attempt.requestId !== requestId) return;
    // A read started before the mutation response must not reopen a terminal
    // failed/review operation as pending when that older response arrives late.
    if (status === 'pending' && ['failed', 'review'].includes(attempt.status)) return;
    setNotice(refundNotices[status]);
    if (status === 'succeeded') {
      refundAttemptRef.current = null; setRefundAttempt(null);
      setRefundConfirmed(false); setRefundAmount(''); setRefundReason(''); setRefundOrder('');
      setError('');
    } else {
      const next = { ...attempt, status };
      refundAttemptRef.current = next; setRefundAttempt(next);
    }
  }, []);

  const refresh = useCallback(async () => {
    pendingRefresh.current?.abort();
    const controller = new AbortController();
    pendingRefresh.current = controller;
    const [overview, allPayments] = await Promise.all([
      call<Overview>('billing', undefined, controller.signal),
      admin ? call<{ payments: Payment[]; refunds?: Refund[] }>('admin/payments', undefined, controller.signal) : Promise.resolve(null),
    ]);
    if (controller.signal.aborted || !mounted.current) return;
    setData(overview);
    if (allPayments) {
      setPayments(allPayments.payments);
      const operations = allPayments.refunds || [];
      setRefunds(operations);
      const current = operations.find(operation => operation.request_id === refundAttemptRef.current?.requestId);
      if (current) applyRefundOutcome(current.request_id, current.status);
    }
  }, [admin, applyRefundOutcome]);

  useEffect(() => {
    mounted.current = true;
    const refreshSafely = () => { refresh().catch(cause => { if (mounted.current && cause.name !== 'AbortError') setError(cause.message); }); };
    refreshSafely();
    const controller = new AbortController();
    if (admin) call<{ config: Config }>('admin/billing', undefined, controller.signal).then(result => { if (!controller.signal.aborted) setConfig(result.config); }).catch(cause => { if (cause.name !== 'AbortError') setError(cause.message); });
    const unsubscribe = subscribeBillingUpdates(refreshSafely);
    return () => { mounted.current = false; controller.abort(); pendingRefresh.current?.abort(); unsubscribe(); };
  }, [admin, refresh]);

  async function reconcile(orderId: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      await call('payments/reconcile', { orderId });
      await refresh();
      notifyBillingUpdated();
      setNotice('결제 제공사에서 최신 상태를 확인했습니다.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function runRefund(attempt: RefundAttempt) {
    if (busy || refundSubmitting.current) return;
    refundSubmitting.current = true;
    const uncertain: RefundAttempt = { ...attempt, status: 'uncertain' };
    refundAttemptRef.current = uncertain; setRefundAttempt(uncertain);
    setRefundOrder(attempt.orderId); setRefundAmount(String(attempt.amount)); setRefundReason(attempt.reason);
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await call<RefundResult>('admin/payments/cancel', { orderId: attempt.orderId, amount: attempt.amount, reason: attempt.reason, requestId: attempt.requestId });
      if (result.refundRequestId !== attempt.requestId || !['pending', 'succeeded', 'failed', 'review'].includes(result.refundStatus)) throw new Error('환불 결과를 확정할 수 없습니다. 기존 요청으로 다시 확인해 주세요.');
      if (mounted.current) { applyRefundOutcome(result.refundRequestId, result.refundStatus); notifyBillingUpdated(); }
    } catch (cause) {
      if (mounted.current && refundAttemptRef.current?.requestId === attempt.requestId) setError((cause as Error).message);
      // Keep the exact order, amount, reason and idempotency key. A timeout or
      // transport failure cannot prove that the provider rejected this refund.
    } finally {
      if (mounted.current) {
        try { await refresh(); } catch (cause) { if ((cause as Error).name !== 'AbortError') setError(previous => previous || '최신 환불 내역을 불러오지 못했습니다. 기존 요청으로 다시 확인해 주세요.'); }
        setBusy(false);
      }
      refundSubmitting.current = false;
    }
  }

  async function submitRefund(event: React.FormEvent) {
    event.preventDefault();
    if (!refundConfirmed || busy || refundAttemptRef.current) return;
    const amount = Number(refundAmount), reason = refundReason.trim();
    if (!Number.isSafeInteger(amount) || amount <= 0 || !reason || reason.length > 200 || !refundOrder) { setError('환불할 주문, 원 단위 정수 금액과 사유를 확인해 주세요.'); return; }
    await runRefund({ orderId: refundOrder, amount, reason, requestId: crypto.randomUUID(), status: 'uncertain' });
  }

  const selectedRefund = payments.find(payment => payment.id === refundOrder);
  const lockedRefundOrders = new Set(refunds.filter(operation => ['pending', 'review'].includes(operation.status)).map(operation => operation.payment_id));
  return <div className="page-inner billing-panel">
    <div className="page-heading row-heading"><div><span className="eyebrow">YOUR AI CREDITS</span><h1>충전 및 이용 내역</h1><p>선불 크레딧과 사용 내역을 확인하세요. 자동 갱신되는 구독은 없습니다.</p></div><a className="primary-button" href="/upgrade" target="_blank" rel="noopener noreferrer">업그레이드 ↗</a></div>
    <section className="info-panel"><div><strong>Flash-Lite는 무료, 다른 모델은 충전한 크레딧으로 이용합니다.</strong><p>Gemini 3.5 Flash-Lite에는 무료 이용 한도가 적용되며 유료 잔액을 차감하지 않습니다. GPT-6.1 Sol, GPT-6 Astra, Claude Fable 5.1, Gemini 4 Argon은 확인된 사용량만큼 차감됩니다. 테스트 결제 잔액은 유료 AI 사용에 쓰이지 않습니다.</p></div></section>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}
    {!data ? <p role="status">{error ? <button className="secondary-button" onClick={() => { setError(''); refresh().catch(cause => setError(cause.message)); }}>다시 불러오기</button> : '충전 정보를 확인하고 있습니다.'}</p> : <>
      <div className="stats-grid">
        <div className="stat-card"><div>사용 가능 잔액</div><strong>{won(data.balance / 1e6)}</strong><small>진행 중인 요청의 예약금 제외</small></div>
        <div className="stat-card"><div>결제 상태</div><strong>{data.mode === 'disabled' ? '준비 중' : data.mode === 'test' ? '테스트' : '실결제'}</strong><small>{data.mode === 'disabled' ? '준비가 완료되면 충전할 수 있습니다.' : '일회성 충전 · 자동 결제 없음'}</small></div>
        <div className="stat-card"><div>테스트 잔액</div><strong>{won(data.testBalance / 1e6)}</strong><small>실제 청구 및 AI 사용 불가</small></div>
      </div>
      <section className="data-panel"><div className="section-heading"><h2>충전 내역</h2><button className="secondary-button" disabled={busy} onClick={() => refresh().catch(cause => setError(cause.message))}>새로고침</button></div>
        {!data.payments.length ? <p>아직 충전 내역이 없습니다.</p> : <div className="table-scroll"><table><thead><tr><th>날짜 (한국 시간)</th><th>상품</th><th>결제 / 환불</th><th>구분</th><th>상태</th><th>확인</th></tr></thead><tbody>{data.payments.map(payment => <tr key={payment.id}>
          <td>{date(payment.created_at)}</td><td>{payment.order_name || 'Prism 크레딧'}<br /><small>{payment.id}</small></td><td>{won(payment.amount)}{payment.refunded_amount > 0 && <><br /><small>환불 {won(payment.refunded_amount)}</small></>}</td><td>{payment.mode === 'test' ? '테스트' : '실결제'}</td><td>{paymentLabels[payment.status] || payment.status}</td><td>{['pending', 'paid', 'partially_refunded', 'review'].includes(payment.status) && <button className="text-button" disabled={busy} onClick={() => reconcile(payment.id)}>상태 확인</button>}</td>
        </tr>)}</tbody></table></div>}
      </section>
      <section className="data-panel"><h2>환불 처리 내역</h2>{!data.refunds?.length ? <p>환불 요청 내역이 없습니다.</p> : <>
        <div className="table-scroll"><table><thead><tr><th>접수일 (한국 시간)</th><th>주문</th><th>금액</th><th>구분</th><th>처리 상태</th></tr></thead><tbody>{data.refunds.map(refund => {
          const mode = refund.mode || data.payments.find(payment => payment.id === refund.payment_id)?.mode;
          return <tr key={refund.id}><td>{date(refund.created_at)}</td><td>{refund.payment_id}</td><td>{won(refund.amount)}</td><td>{mode === 'test' ? '테스트' : mode === 'live' ? '실결제' : '주문 내역 확인'}</td><td>{refundLabels[refund.status]}{['pending', 'review'].includes(refund.status) && <><br /><small>확인 전까지 해당 금액 보류</small></>}</td></tr>;
        })}</tbody></table></div>
        <p>진행 중인 환불은 완료된 환불과 구분됩니다. 결과를 확인하는 동안 해당 금액은 사용 가능 잔액에서 제외됩니다.</p>
      </>}</section>
      <section className="data-panel"><h2>잔액 변동 내역</h2>{!data.events.length ? <p>잔액 변동이 없습니다.</p> : <div className="table-scroll"><table><thead><tr><th>날짜 (한국 시간)</th><th>내용</th><th>구분</th><th>변동 금액</th></tr></thead><tbody>{data.events.map(event => <tr key={event.reference}><td>{date(event.created_at)}</td><td>{eventLabels[event.kind] || event.kind}</td><td>{event.mode === 'test' ? '테스트' : '실결제'}</td><td>{won(event.amount / 1e6)}</td></tr>)}</tbody></table></div>}</section>
      <section className="data-panel"><h2>모델별 차감 단가</h2><p>100만 토큰당 원화 기준입니다. 사용 가능한 모델과 적용 단가는 서비스 운영 상태에 따라 달라집니다.</p>{Object.keys(data.rates).length ? <div className="table-scroll"><table><thead><tr><th>모델</th><th>입력</th><th>출력·추론</th></tr></thead><tbody>{Object.entries(data.rates).map(([id, rate]) => <tr key={id}><td>{MODELS.find(model => model.id === id)?.name || id}</td><td>{won(rate.input)}</td><td>{won(rate.output)}</td></tr>)}</tbody></table></div> : <p>유료 이용 단가를 준비하고 있습니다.</p>}<p>요청 전에 최대 사용 비용을 예약하고, 확인된 실제 사용량으로 정산합니다. 사용량 확인이 필요한 요청의 예약금은 정산까지 보류됩니다.</p></section>
      <section className="data-panel"><h2>환불 및 유효기간</h2><p>{data.refundPolicy || '환불 기준은 충전 판매 시작 전에 안내합니다.'}</p><p>{data.validityPolicy || '크레딧 유효기간은 충전 판매 시작 전에 안내합니다.'}</p>{data.business.supportEmail && <a href={'mailto:' + data.business.supportEmail}>고객지원에 문의하기</a>}</section>
      <section className="data-panel"><h2>판매자 정보</h2><p>{data.business.name} · 대표자 {data.business.representative}</p>{data.business.registrationNumber && <p>사업자등록번호: {data.business.registrationNumber}</p>}{data.business.address && <p>사업장 주소: {data.business.address}</p>}{data.business.supportEmail && <p>고객지원: {data.business.supportEmail}</p>}</section>
    </>}
    {admin && <>
      {data && data.blockers.length > 0 && <section className="data-panel"><h2>출시 준비 현황</h2><ul>{data.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul><p>설정 저장만으로 실결제가 시작되지는 않습니다. 결제 키와 별도의 출시 승인이 필요합니다.</p></section>}
      {config && <section className="data-panel"><h2>출시 설정</h2><form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await call('admin/billing', config); await refresh(); setNotice('설정을 저장했습니다. 변경된 정책은 다음 주문부터 적용됩니다.'); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } }}>
        {(['registrationNumber', 'address', 'supportEmail', 'refundPolicy', 'validityPolicy'] as const).map((key, index) => <label className="billing-field" key={key}>{['사업자등록번호', '사업장 주소', '고객지원 이메일', '환불 기준', '충전금 유효기간'][index]}<input value={config[key]} maxLength={4000} onChange={event => setConfig({ ...config, [key]: event.target.value })} /></label>)}
        <h3>모델별 단가 (100만 토큰당 원)</h3>{MODELS.map(model => <div className="billing-rate" key={model.id}><span>{model.name}</span>{(['input', 'output'] as const).map((key, index) => <label key={key}>{index ? '출력' : '입력'}<input type="number" min="1" max="1000000" step="1" value={config.rates[model.id]?.[key] ?? ''} onChange={event => { const rates = { ...config.rates }; const value = Number(event.target.value); if (event.target.value === '') delete rates[model.id]; else rates[model.id] = { input: rates[model.id]?.input || value, output: rates[model.id]?.output || value, [key]: value }; setConfig({ ...config, rates }); }} /></label>)}</div>)}
        <button className="primary-button" disabled={busy}>설정 저장</button>
      </form></section>}
      <section className="data-panel"><h2>결제 및 환불 관리</h2><p>최근 100건의 주문을 확인합니다. 환불이 완료되면 해당 금액의 크레딧을 회수합니다.</p>
        {!payments.length ? <p>접수된 주문이 없습니다.</p> : <>
          <div className="table-scroll"><table><thead><tr><th>주문</th><th>금액</th><th>환불 누계</th><th>구분</th><th>상태</th></tr></thead><tbody>{payments.map(payment => <tr key={payment.id}><td>{payment.id}<br /><small>{payment.user_id}</small></td><td>{won(payment.amount)}</td><td>{won(payment.refunded_amount || 0)}</td><td>{payment.mode === 'test' ? '테스트' : '실결제'}</td><td>{paymentLabels[payment.status] || payment.status}</td></tr>)}</tbody></table></div>
          {refundAttempt && <div className="info-panel" role="status"><div>
            <strong>{refundAttempt.status === 'uncertain' ? '환불 결과가 아직 확정되지 않았습니다.' : refundLabels[refundAttempt.status]}</strong>
            <p>{refundAttempt.status === 'uncertain' ? '동일한 요청으로 다시 확인할 수 있습니다. 결과 확인 전에는 같은 금액의 새 환불 요청을 만들지 마세요.' : refundNotices[refundAttempt.status]}</p>
            <p>주문 {refundAttempt.orderId}<br />환불 금액 {won(refundAttempt.amount)}<br />요청 번호 {refundAttempt.requestId}</p>
            {['uncertain', 'pending'].includes(refundAttempt.status) && <button className="secondary-button" disabled={busy} onClick={() => void runRefund(refundAttempt)}>기존 환불 요청 확인 / 재시도</button>}
            {refundAttempt.status === 'failed' && <button className="secondary-button" disabled={busy} onClick={() => { refundAttemptRef.current = null; setRefundAttempt(null); setRefundConfirmed(false); setRefundAmount(''); setRefundReason(''); setRefundOrder(''); }}>실패한 요청 확인 후 입력 초기화</button>}
          </div></div>}
          <form onSubmit={submitRefund}>
            <label className="billing-field">환불할 주문<select required disabled={busy || !!refundAttempt} value={refundOrder} onChange={event => { setRefundOrder(event.target.value); setRefundAmount(''); setRefundConfirmed(false); }}><option value="">주문 선택</option>{payments.filter(payment => payment.id === refundAttempt?.orderId || (['paid', 'partially_refunded'].includes(payment.status) && !lockedRefundOrders.has(payment.id) && payment.amount > (payment.refunded_amount || 0))).map(payment => <option key={payment.id} value={payment.id}>{payment.mode === 'test' ? '[테스트]' : '[실결제]'} {payment.id} · 남은 결제금 {won(payment.amount - (payment.refunded_amount || 0))}</option>)}</select></label>
            <label className="billing-field">환불 금액 (원)<input required disabled={busy || !!refundAttempt} type="number" min="1" step="1" max={selectedRefund ? selectedRefund.amount - (selectedRefund.refunded_amount || 0) : undefined} value={refundAmount} onChange={event => { setRefundAmount(event.target.value); setRefundConfirmed(false); }} /></label>
            <label className="billing-field">환불 사유<input required disabled={busy || !!refundAttempt} maxLength={200} value={refundReason} onChange={event => { setRefundReason(event.target.value); setRefundConfirmed(false); }} /></label>
            <label><input type="checkbox" disabled={busy || !!refundAttempt} checked={refundConfirmed} onChange={event => setRefundConfirmed(event.target.checked)} /> 선택한 주문과 환불 금액을 확인했습니다.</label>
            <p><button className="primary-button" disabled={busy || !!refundAttempt || !refundOrder || !refundConfirmed}>{busy ? '처리 중…' : '선택한 금액 환불'}</button></p>
          </form>
        </>}
      </section>
      <section className="data-panel"><div className="section-heading"><h2>최근 환불 요청</h2><button className="secondary-button" disabled={busy} onClick={() => refresh().catch(cause => setError(cause.message))}>환불 내역 새로고침</button></div>
        {!refunds.length ? <p>접수된 환불 요청이 없습니다.</p> : <div className="table-scroll"><table><thead><tr><th>접수 / 갱신 (한국 시간)</th><th>주문 / 요청 번호</th><th>금액 / 구분</th><th>사유</th><th>처리 상태</th><th>확인</th></tr></thead><tbody>{refunds.map(refund => <tr key={refund.id}>
          <td>{date(refund.created_at)}{refund.updated_at && <><br /><small>{date(refund.updated_at)}</small></>}</td>
          <td>{refund.payment_id}<br /><small>{refund.request_id}</small></td>
          <td>{won(refund.amount)}<br /><small>{refund.mode === 'test' ? '테스트' : refund.mode === 'live' ? '실결제' : '주문 내역 확인'}</small></td>
          <td>{refund.reason || '사유 확인 필요'}</td><td>{refundLabels[refund.status]}{['pending', 'review'].includes(refund.status) && <><br /><small>금액 보류 중</small></>}{refund.last_error && <><br /><small>확인 코드: {refund.last_error}</small></>}</td>
          <td>{refund.status === 'pending' ? <button className="text-button" disabled={busy || !refund.reason || (refundAttempt?.status === 'uncertain' && refundAttempt.requestId !== refund.request_id)} onClick={() => {
            if (refund.reason) void runRefund({ orderId: refund.payment_id, amount: refund.amount, reason: refund.reason, requestId: refund.request_id, status: 'pending' });
          }}>기존 요청 확인 / 재시도</button> : refund.status === 'review' ? <span>제공사 내역 수동 확인</span> : refund.status === 'succeeded' ? <span>완료</span> : <span>실패 내역 확인</span>}</td>
        </tr>)}</tbody></table></div>}
      </section>
    </>}
  </div>;
}
