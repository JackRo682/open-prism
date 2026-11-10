'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { CreditCard, LoaderCircle, LockKeyhole } from 'lucide-react';
import type { PaymentOrder } from '../../lib/billing-contract';
import { isTossCancellation, loadTossPayments, type TossPayment, type TossWidgetControl, type TossWidgets } from '../../lib/toss-client';
import { formatWon } from './api';

export function TossCheckout({ order, onBusyChange }: { order: PaymentOrder; onBusyChange?: (busy: boolean) => void }) {
  const prefix = `prism-payment-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [ready, setReady] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [retry, setRetry] = useState(0);
  const [canRetryLoad, setCanRetryLoad] = useState(false);
  const widgets = useRef<TossWidgets | null>(null);
  const payment = useRef<TossPayment | null>(null);
  const submission = useRef(false);
  const active = useRef(false);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    const controls: TossWidgetControl[] = [];
    const destroy = (control: TossWidgetControl) => { try { Promise.resolve(control.destroy()).catch(() => {}); } catch { /* A superseded widget may already be destroyed. */ } };
    setReady(false);
    setAgreed(false);
    setError('');
    setCanRetryLoad(false);
    widgets.current = null;
    payment.current = null;
    (async () => {
      try {
        const TossPayments = await loadTossPayments();
        if (cancelled) return;
        const client = TossPayments(order.clientKey);
        if (order.checkoutKind === 'payment') {
          payment.current = client.payment({ customerKey: order.customerKey });
          setReady(true);
          return;
        }
        const instance = client.widgets({ customerKey: order.customerKey });
        await instance.setAmount({ currency: 'KRW', value: order.amount });
        if (cancelled) return;
        const methods = await instance.renderPaymentMethods({ selector: `#${prefix}-methods`, variantKey: 'DEFAULT' });
        if (cancelled) { destroy(methods); return; }
        controls.push(methods);
        const agreement = await instance.renderAgreement({ selector: `#${prefix}-agreement`, variantKey: 'AGREEMENT' });
        if (cancelled) { destroy(agreement); return; }
        controls.push(agreement);
        agreement.on('agreementStatusChange', status => { if (!cancelled) setAgreed(status.agreedRequiredTerms === true); });
        widgets.current = instance;
        setReady(true);
      } catch (cause) {
        for (const control of controls.splice(0)) destroy(control);
        if (cancelled) return;
        setError(cause instanceof Error && cause.message.startsWith('결제') ? cause.message : '결제수단을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
        setCanRetryLoad(true);
      }
    })();
    return () => {
      cancelled = true;
      widgets.current = null;
      payment.current = null;
      for (const control of controls) destroy(control);
    };
  }, [order.orderId, order.clientKey, order.customerKey, order.amount, order.checkoutKind, prefix, retry]);

  async function pay() {
    if (!ready || submission.current || (order.checkoutKind === 'widget' && !agreed)) return;
    submission.current = true;
    setSubmitting(true);
    setError('');
    onBusyChange?.(true);
    try {
      const urls = {
        orderId: order.orderId,
        orderName: order.orderName,
        successUrl: new URL('/upgrade/success', window.location.origin).href,
        failUrl: new URL(`/upgrade/fail?order=${encodeURIComponent(order.orderId)}`, window.location.origin).href,
      };
      if (order.checkoutKind === 'widget') {
        if (!widgets.current) throw new Error('결제수단을 다시 불러와 주세요.');
        await widgets.current.requestPayment(urls);
      } else {
        if (!payment.current) throw new Error('결제창을 다시 불러와 주세요.');
        await payment.current.requestPayment({ ...urls, method: 'CARD', amount: { currency: 'KRW', value: order.amount } });
      }
      // The provider redirects to the callback. No client-side credit or success is inferred here.
    } catch (cause) {
      if (active.current) setError(isTossCancellation(cause)
        ? '결제창이 닫혔습니다. 같은 주문으로 다시 진행하거나 충전 내역에서 결제 상태를 확인할 수 있습니다.'
        : '결제를 완료하지 못했습니다. 다시 시도하기 전에 결제 상태를 확인해 주세요.');
    } finally {
      submission.current = false;
      if (active.current) { setSubmitting(false); onBusyChange?.(false); }
    }
  }

  return <div className="prism-upgrade-checkout-widget" aria-busy={!ready && !error || submitting}>
    {order.mode === 'test' && <p className="prism-upgrade-notice test" role="status">테스트 결제 · 실제 금액이 청구되지 않습니다.</p>}
    {order.checkoutKind === 'widget' ? <>
      <div id={`${prefix}-methods`} className="prism-upgrade-provider-methods" />
      <div id={`${prefix}-agreement`} className="prism-upgrade-provider-agreement" />
    </> : <div className="prism-upgrade-provider-window-note"><CreditCard size={26} aria-hidden="true" /><div><h3>카드 · 간편결제</h3><p>토스페이먼츠 결제창에서 사용할 결제수단을 선택하고 인증합니다.</p></div></div>}
    {!ready && !error && <p className="prism-upgrade-loading" role="status"><LoaderCircle className="prism-upgrade-spin" size={18} aria-hidden="true" />결제수단을 불러오고 있습니다.</p>}
    {error && <div className="prism-upgrade-notice error" role="alert"><p>{error}</p>{canRetryLoad && <button className="prism-upgrade-text-button" disabled={submitting} onClick={() => setRetry(value => value + 1)}>다시 불러오기</button>}<a href={`/upgrade/success?orderId=${encodeURIComponent(order.orderId)}`} className="prism-upgrade-text-link">이 주문의 결제 상태 확인</a></div>}
    <button className="prism-upgrade-button prism-upgrade-pay-button" disabled={!ready || submitting || (order.checkoutKind === 'widget' && !agreed)} onClick={pay}>
      {submitting ? <><LoaderCircle className="prism-upgrade-spin" size={18} aria-hidden="true" />결제 진행 중…</> : <>{formatWon(order.amount)} {order.mode === 'test' ? '테스트 결제' : '결제하기'}</>}
    </button>
    {ready && order.checkoutKind === 'widget' && !agreed && <p className="prism-upgrade-fineprint">필수 결제 약관에 동의하면 결제할 수 있습니다.</p>}
    <p className="prism-upgrade-security"><LockKeyhole size={14} aria-hidden="true" />결제 인증은 토스페이먼츠에서 진행됩니다.</p>
  </div>;
}
