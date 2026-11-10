'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CircleHelp, CreditCard, LoaderCircle, RotateCcw } from 'lucide-react';
import type { PaymentState, PaymentStatus } from '../../lib/billing-contract';
import { notifyBillingUpdated } from '../../lib/billing-sync';
import { forgetPendingOrder, formatWon, pendingOrderId, UpgradeApiError, upgradeRequest, upgradeSignInHref } from './api';
import { UpgradeShell } from './UpgradeShell';
import { clearPaymentReturn, parsePaymentReturn, paymentAuthReturnPath, paymentReturnStorage, readPaymentReturn, storePaymentReturn, type PaymentReturnInput } from './return-state';

const states: Record<PaymentState, string> = {
  pending: '결제 대기', paid: '충전 완료', partially_refunded: '일부 환불', refunded: '환불 완료',
  expired: '주문 만료', failed: '결제 실패', review: '결제 확인 필요',
};

export default function PaymentResult({ kind }: { kind: 'success' | 'fail' }) {
  const [input, setInput] = useState<PaymentReturnInput | null>(null);
  const [result, setResult] = useState<PaymentStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [signInRequired, setSignInRequired] = useState(false);
  const [separateLogin, setSeparateLogin] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | undefined>();
  const [invalid, setInvalid] = useState(false);
  const [checkNumber, setCheckNumber] = useState(0);
  const announced = useRef('');
  const mounted = useRef(false);
  const checking = useRef(false);
  const generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);

  const applyResult = useCallback((payment: PaymentStatus) => {
    setResult(payment);
    setSignedIn(true);
    setSignInRequired(false);
    const finalPayment = ['paid', 'partially_refunded', 'refunded'].includes(payment.status);
    if (finalPayment) {
      const notification = `${payment.orderId}:${payment.status}:${payment.refundedAmount}`;
      if (announced.current !== notification) { announced.current = notification; notifyBillingUpdated(); }
      forgetPendingOrder(payment.orderId);
      clearPaymentReturn(paymentReturnStorage(), payment.orderId);
      // Retain an owned order lookup for reloads, never a payment key in history or storage.
      window.history.replaceState(window.history.state, '', `/upgrade/success?orderId=${encodeURIComponent(payment.orderId)}`);
      setInput({ orderId: payment.orderId, cancelled: false });
    }
  }, []);

  const check = useCallback(async (value: PaymentReturnInput, reconcile: boolean) => {
    if (checking.current) return;
    checking.current = true;
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setSignInRequired(false);
    try {
      let payment: PaymentStatus;
      if (value.paymentKey && value.amount !== undefined) {
        payment = await upgradeRequest<PaymentStatus>('payments/confirm', { orderId: value.orderId, paymentKey: value.paymentKey, amount: value.amount });
      } else {
        // A completed order remains viewable after checkout is disabled or its
        // test/live credentials change. Only unresolved orders need the provider.
        payment = await upgradeRequest<PaymentStatus>(`payments/orders/${encodeURIComponent(value.orderId)}`);
        if (reconcile && payment.canReconcile && ['pending', 'review'].includes(payment.status)) {
          payment = await upgradeRequest<PaymentStatus>('payments/reconcile', { orderId: value.orderId });
        }
      }
      if (mounted.current && current === generation.current) { applyResult(payment); setCheckNumber(count => count + 1); }
    } catch (cause) {
      if (!mounted.current || current !== generation.current) return;
      if (cause instanceof UpgradeApiError && cause.status === 401) {
        setSignInRequired(true);
        setSignedIn(false);
        // Widget keys do not support provider lookup by order ID. Preserve the
        // bounded callback in this tab only so login never loses its payment key.
        const preserved = !value.paymentKey || storePaymentReturn(paymentReturnStorage(), value);
        setSeparateLogin(!preserved);
        setError(preserved ? '로그인한 계정에서 결제 상태를 확인할 수 있습니다.' : '이 브라우저에서는 결제 복귀 정보를 임시로 저장할 수 없습니다. 새 탭에서 로그인한 뒤 이 결제 탭으로 돌아와 다시 확인해 주세요.');
        if (preserved) window.history.replaceState(window.history.state, '', paymentAuthReturnPath(kind, value.orderId));
      } else {
        setError(cause instanceof Error ? cause.message : '결제 상태를 확인하지 못했습니다.');
        if (cause instanceof UpgradeApiError && cause.status === 404) setInvalid(true);
      }
    } finally {
      checking.current = false;
      if (mounted.current && current === generation.current) setBusy(false);
    }
  }, [applyResult, kind]);

  useEffect(() => {
    mounted.current = true;
    try {
      let value = parsePaymentReturn(window.location.search, kind, kind === 'fail' ? pendingOrderId() : null);
      if (value.paymentKey) storePaymentReturn(paymentReturnStorage(), value);
      else if (kind === 'success') value = readPaymentReturn(paymentReturnStorage(), value.orderId) || value;
      setInput(value);
      // Success returns without a key are login/lost-redirect recovery. Failure
      // returns only read current state until the user explicitly retries lookup.
      void check(value, kind === 'success');
    } catch (cause) {
      setInvalid(true);
      setBusy(false);
      setError(cause instanceof Error ? cause.message : '결제 정보를 확인할 수 없습니다.');
    }
    return () => { mounted.current = false; };
  }, [check, kind]);

  useEffect(() => { if (!busy) heading.current?.focus(); }, [busy]);

  const completed = result?.status === 'paid';
  const refunded = result?.status === 'partially_refunded' || result?.status === 'refunded';
  const title = busy ? '결제 상태를 확인하고 있습니다' : signInRequired ? '로그인하고 결제를 확인해 주세요' : completed ?
    result.mode === 'test' ? '테스트 결제가 완료되었습니다' : '크레딧 충전이 완료되었습니다' : refunded ?
      result.status === 'refunded' ? '환불이 완료된 결제입니다' : '일부 금액이 환불된 결제입니다' : result?.status === 'expired' ? '주문의 유효기간이 지났습니다' :
        result?.status === 'review' ? '결제 상태 확인이 필요합니다' : error || invalid ? '결제를 확인하지 못했습니다' : kind === 'fail' ? '결제가 완료되지 않았습니다' : '아직 결제 완료가 확인되지 않았습니다';
  const loginReturn = input && !separateLogin ? paymentAuthReturnPath(kind, input.orderId) : '/upgrade';

  return <UpgradeShell signedIn={signedIn} signInHref={upgradeSignInHref(loginReturn)} signInTarget={separateLogin ? '_blank' : '_top'}>
    <section className="prism-upgrade-result" aria-busy={busy}>
      <div className={`prism-upgrade-result-symbol ${completed ? 'complete' : refunded ? 'refund' : ''}`} aria-hidden="true">
        {busy ? <LoaderCircle className="prism-upgrade-spin" size={32} /> : completed ? <Check size={34} /> : refunded ? <RotateCcw size={30} /> : <CreditCard size={32} />}
      </div>
      <h1 ref={heading} tabIndex={-1}>{title}</h1>
      {busy ? <p role="status">확인이 끝날 때까지 잠시 기다려 주세요.</p> : <>
        {error && <p className="prism-upgrade-result-error" role="alert">{error}</p>}
        {completed && <p role="status">{result.mode === 'test' ? '테스트 잔액에만 반영되었습니다. 실제 AI 이용 잔액은 변경되지 않습니다.' : '충전한 크레딧이 계정에 반영되었습니다. 열려 있는 채팅에서도 최신 잔액을 확인할 수 있습니다.'}</p>}
        {refunded && <p role="status">아래 금액은 서버에서 확인한 환불 상태입니다. 환불 후 잔액은 계정의 충전 및 이용 내역에서 확인할 수 있습니다.</p>}
        {!completed && !refunded && !error && <p>{kind === 'fail' && input?.cancelled ? '결제창이 닫혔습니다. ' : ''}결제 상태를 다시 확인한 뒤 진행해 주세요. 완료 여부는 충전 내역에도 표시됩니다.</p>}
      </>}
      {result && <dl className="prism-upgrade-result-details">
        <div><dt>상품</dt><dd>{result.orderName}</dd></div>
        <div><dt>주문 금액</dt><dd>{formatWon(result.amount)}</dd></div>
        <div><dt>결제 구분</dt><dd>{result.mode === 'test' ? '테스트 결제' : '실결제'}</dd></div>
        <div><dt>결제 상태</dt><dd>{states[result.status]}</dd></div>
        {result.refundedAmount > 0 && <div><dt>환불 금액</dt><dd>{formatWon(result.refundedAmount)}</dd></div>}
        {result.pendingRefundAmount > 0 && <div><dt>환불 확인 중</dt><dd>{formatWon(result.pendingRefundAmount)}</dd></div>}
        {(completed || refunded) && <div className="prism-upgrade-result-balance"><dt>{result.mode === 'test' ? '테스트 잔액' : '사용 가능 잔액'}</dt><dd>{formatWon(result.balance / 1_000_000, true)}</dd></div>}
        <div className="prism-upgrade-result-order"><dt>주문 번호</dt><dd>{result.orderId}</dd></div>
      </dl>}
      <div className="prism-upgrade-result-actions">
        {signInRequired ? <a className="prism-upgrade-button" href={upgradeSignInHref(loginReturn)} target={separateLogin ? '_blank' : '_top'} rel="noopener noreferrer">{separateLogin ? '새 탭에서 로그인' : '로그인하고 계속'}</a> : !completed && !refunded && input && !invalid ?
          <button className="prism-upgrade-button" disabled={busy} onClick={() => void check(input, true)}>{busy ? '확인 중…' : '결제 상태 다시 확인'}</button> : null}
        {signInRequired && separateLogin && input && <button className="prism-upgrade-outline-button" disabled={busy} onClick={() => void check(input, true)}>로그인 후 다시 확인</button>}
        {(completed || refunded) && <a className="prism-upgrade-button" href="/chat">채팅으로 돌아가기</a>}
        {!busy && <a className="prism-upgrade-outline-button" href="/billing">충전 및 이용 내역</a>}
        {!busy && !completed && !refunded && <a className="prism-upgrade-text-link" href="/upgrade">충전 화면으로 돌아가기</a>}
      </div>
      {!busy && !completed && !refunded && checkNumber > 0 && <p className="prism-upgrade-result-help"><CircleHelp size={16} aria-hidden="true" />이미 결제수단에서 금액이 승인되었다면 새 주문을 만들기 전에 이 주문의 상태를 다시 확인해 주세요.</p>}
    </section>
  </UpgradeShell>;
}
