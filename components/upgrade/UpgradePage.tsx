'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CircleHelp, CreditCard, LoaderCircle, ShieldCheck, Sparkles } from 'lucide-react';
import type { BillingProduct, PaymentOrder, UpgradeOverview } from '../../lib/billing-contract';
import { subscribeBillingUpdates } from '../../lib/billing-sync';
import { UpgradeApiError, formatWon, rememberPendingOrder, upgradeRequest, upgradeSignInHref } from './api';
import { UpgradeShell } from './UpgradeShell';
import { PlanDialog } from './PlanDialog';
import { TermsDialog } from './TermsDialog';
import { TossCheckout } from './TossCheckout';

type OrderIntent = { productId: string; requestId: string; consent: { accepted: true; version: string; policyHash: string } };
type CheckoutState = { product: BillingProduct; order: PaymentOrder | null; pending: boolean; error: string; requiresSignIn: boolean; intent: OrderIntent | null };

export default function UpgradePage() {
  const [data, setData] = useState<UpgradeOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [plansOpen, setPlansOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [selected, setSelected] = useState<BillingProduct | null>(null);
  const [checkout, setCheckout] = useState<CheckoutState | null>(null);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const selectedTrigger = useRef<HTMLButtonElement | null>(null);
  const checkoutTitle = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const orderPending = useRef(false);
  const restoreSelection = useRef(true);
  const orderGeneration = useRef(0);
  const overviewGeneration = useRef(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = ++overviewGeneration.current;
    try {
      const next = await upgradeRequest<UpgradeOverview>('upgrade', undefined, signal);
      if (!mounted.current || signal?.aborted || generation !== overviewGeneration.current) return;
      setData(next);
      setError('');
      if (restoreSelection.current) {
        restoreSelection.current = false;
        const productId = new URLSearchParams(window.location.search).get('product');
        const product = next.products.find(item => item.id === productId);
        if (product) { setSelected(product); setPlansOpen(true); setTermsOpen(true); }
      }
    } catch (cause) {
      if (!mounted.current || signal?.aborted || generation !== overviewGeneration.current) return;
      setError(cause instanceof Error ? cause.message : '충전 정보를 불러오지 못했습니다.');
    } finally {
      if (mounted.current && !signal?.aborted && generation === overviewGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const unsubscribe = subscribeBillingUpdates(() => { void refresh(); });
    return () => { mounted.current = false; controller.abort(); unsubscribe(); };
  }, [refresh]);

  useEffect(() => {
    if (checkout) {
      const frame = requestAnimationFrame(() => { checkoutTitle.current?.focus(); window.scrollTo({ top: 0, behavior: 'instant' }); });
      return () => cancelAnimationFrame(frame);
    }
  }, [!!checkout]);

  async function createOrder(product: BillingProduct, intent: OrderIntent) {
    if (orderPending.current) return;
    orderPending.current = true;
    const generation = ++orderGeneration.current;
    setCheckout({ product, intent, order: null, pending: true, error: '', requiresSignIn: false });
    try {
      const order = await upgradeRequest<PaymentOrder>('payments/orders', intent);
      if (!mounted.current || generation !== orderGeneration.current) return;
      rememberPendingOrder(order.orderId);
      setCheckout({ product, intent, order, pending: false, error: '', requiresSignIn: false });
    } catch (cause) {
      if (!mounted.current || generation !== orderGeneration.current) return;
      const requiresSignIn = cause instanceof UpgradeApiError && cause.status === 401;
      setCheckout({ product, intent: cause instanceof UpgradeApiError && cause.status === 409 ? null : intent, order: null, pending: false, error: cause instanceof Error ? cause.message : '주문을 생성하지 못했습니다.', requiresSignIn });
      if (cause instanceof UpgradeApiError && [409, 503].includes(cause.status)) void refresh();
    } finally { orderPending.current = false; }
  }

  function continueFromTerms() {
    if (!selected || !data) return;
    setTermsOpen(false);
    setPlansOpen(false);
    if (!data.checkoutAvailable) {
      setCheckout({ product: selected, order: null, pending: false, error: '', requiresSignIn: false, intent: null });
      return;
    }
    if (!data.signedIn) return;
    const intent: OrderIntent = {
      productId: selected.id,
      requestId: crypto.randomUUID(),
      consent: { accepted: true, version: data.terms.version, policyHash: data.terms.policyHash },
    };
    void createOrder(selected, intent);
  }

  function showPlans() {
    if (paymentBusy || checkout?.pending) return;
    ++orderGeneration.current;
    setCheckout(null);
    setPlansOpen(true);
  }

  const lowestPrice = data?.products.length ? Math.min(...data.products.map(product => product.amount)) : null;
  const signInHref = upgradeSignInHref(selected ? `/upgrade?product=${encodeURIComponent(selected.id)}` : '/upgrade');

  return <UpgradeShell signedIn={data?.signedIn} signInHref={signInHref}>
    {loading && !data ? <section className="prism-upgrade-state" aria-live="polite"><LoaderCircle className="prism-upgrade-spin" size={28} aria-hidden="true" /><h1>충전 정보를 불러오고 있습니다</h1></section> : !data ?
      <section className="prism-upgrade-state"><CircleHelp size={32} aria-hidden="true" /><h1>충전 정보를 확인할 수 없습니다</h1><p role="alert">{error}</p><button className="prism-upgrade-button" onClick={() => { setLoading(true); void refresh(); }}>다시 시도</button><a className="prism-upgrade-text-link" href="/chat">채팅으로 돌아가기</a></section> : checkout ? <>
        <div className="prism-upgrade-checkout-column">
          <button className="prism-upgrade-back" onClick={showPlans} disabled={paymentBusy || checkout.pending}><ArrowLeft size={18} aria-hidden="true" />충전 금액 선택</button>
          <h1 className="prism-upgrade-checkout-title" ref={checkoutTitle} tabIndex={-1}>크레딧 충전</h1>
          <section className="prism-upgrade-order-summary" aria-label="주문 내용"><span>{checkout.product.name}</span><strong>{formatWon(checkout.order?.amount ?? checkout.product.amount)}</strong><small>1회 충전 · 자동 갱신 없음</small></section>
          <section className="prism-upgrade-checkout-card" aria-label="결제">
            {checkout.pending ? <p className="prism-upgrade-loading" role="status"><LoaderCircle className="prism-upgrade-spin" size={20} aria-hidden="true" />주문을 준비하고 있습니다.</p> : checkout.order ? <TossCheckout key={checkout.order.orderId} order={checkout.order} onBusyChange={setPaymentBusy} /> : checkout.error ?
              <div className="prism-upgrade-checkout-empty"><CircleHelp size={34} aria-hidden="true" /><h2>주문을 준비하지 못했습니다</h2><p role="alert">{checkout.error}</p>
                {checkout.requiresSignIn ? <a className="prism-upgrade-button" href={signInHref} target="_top">로그인하고 계속</a> : checkout.intent && data.checkoutAvailable ? <button className="prism-upgrade-button" onClick={() => { if (checkout.intent) void createOrder(checkout.product, checkout.intent); }}>같은 주문으로 다시 시도</button> : <button className="prism-upgrade-button" onClick={showPlans}>구매 조건 다시 확인</button>}
              </div> : <div className="prism-upgrade-checkout-empty"><CreditCard size={36} aria-hidden="true" /><h2>충전 서비스를 준비하고 있어요</h2><p>선택하신 상품을 확인했습니다. 충전이 시작되면 이 화면에서 결제수단을 선택할 수 있습니다.</p><p>주문이 생성되거나 결제된 금액은 없습니다.</p><button className="prism-upgrade-button" disabled>결제 준비 중</button><a className="prism-upgrade-text-link" href="/chat">채팅으로 돌아가기</a></div>}
          </section>
          {checkout.order && <p className="prism-upgrade-fineprint">결제 인증 후 이 화면으로 돌아오면 주문과 잔액을 확인합니다. <a className="prism-upgrade-text-link" href={`/upgrade/success?orderId=${encodeURIComponent(checkout.order.orderId)}`}>결제 상태 확인</a></p>}
        </div>
      </> : <>
        <h1 className="prism-upgrade-headline">더 여유롭게 사용하세요: <span>Prism</span></h1>
        <div className="prism-upgrade-column">
          <section className="prism-upgrade-current" aria-label="현재 이용 상태">
            <div><span>현재 이용 상태</span><strong>{data.beta ? 'Prism 무료 베타' : data.signedIn ? 'Prism AI 크레딧' : 'Prism 계정'}</strong></div>
            {data.signedIn ? <div className="prism-upgrade-current-balance"><span>사용 가능 잔액</span><strong>{formatWon((data.balance ?? 0) / 1_000_000, true)}</strong></div> : <a className="prism-upgrade-text-link" href={signInHref} target="_top">로그인</a>}
          </section>
          <section className="prism-upgrade-product">
            <p className="prism-upgrade-product-kicker">필요한 만큼 충전</p>
            <h2>Prism AI <span>크레딧</span></h2>
            <p className="prism-upgrade-product-badge"><CreditCard size={14} aria-hidden="true" />선불 크레딧 · 1회 충전</p>
            <div className="prism-upgrade-product-price"><span>충전 금액</span><p>{lowestPrice === null ? '상품 준비 중' : <><strong>{formatWon(lowestPrice)}</strong><span>부터</span></>}</p></div>
            <button ref={opener} className="prism-upgrade-button prism-upgrade-product-cta" onClick={() => setPlansOpen(true)} disabled={!data.products.length}>크레딧 충전하기</button>
            {!data.checkoutAvailable && <p className="prism-upgrade-availability">충전 준비 중 · 상품과 구매 조건을 미리 확인하세요.</p>}
            {data.mode === 'test' && <p className="prism-upgrade-notice test">테스트 결제만 가능합니다. 실제 금액이 청구되지 않습니다.</p>}
            <h3 className="prism-upgrade-feature-heading"><Sparkles size={23} aria-hidden="true" />Prism에서 더 이어가는 작업</h3>
            <ul className="prism-upgrade-features">
              <li><Check size={22} aria-hidden="true" /><div><strong>사용한 만큼 차감</strong><p>이용 가능한 모델의 실제 사용량과 공개된 단가에 따라 차감합니다.</p></div></li>
              <li><Check size={22} aria-hidden="true" /><div><strong>자동 갱신 없는 충전</strong><p>선택한 금액을 한 번 결제합니다. 매달 결제되는 구독이 아닙니다.</p></div></li>
              <li><Check size={22} aria-hidden="true" /><div><strong>한눈에 확인하는 잔액과 내역</strong><p>충전·사용·환불 기록을 계정에서 확인할 수 있습니다.</p></div></li>
            </ul>
            <div className="prism-upgrade-card-bottom"><ShieldCheck size={22} aria-hidden="true" /><p>결제수단 인증은 토스페이먼츠에서 진행합니다. 카드 정보는 Prism에 직접 입력하지 않습니다.</p></div>
          </section>
          {data.mode === 'test' && data.signedIn && <p className="prism-upgrade-fineprint">내 테스트 잔액 {formatWon((data.testBalance ?? 0) / 1_000_000, true)} · 실제 AI 이용 잔액과 별도로 보관됩니다.</p>}
          {error && <p className="prism-upgrade-notice error" role="alert">정보를 새로 확인하지 못했습니다. <button className="prism-upgrade-text-button" onClick={() => void refresh()}>다시 확인</button></p>}
          <details className="prism-upgrade-details"><summary>구매 전 확인사항</summary><div><h3>환불 및 유효기간</h3><p>{data.terms.refundPolicy || '환불 기준을 준비하고 있습니다. 기준 확정 전에는 실제 결제를 진행할 수 없습니다.'}</p><p>{data.terms.validityPolicy || '크레딧 유효기간을 준비하고 있습니다.'}</p><a className="prism-upgrade-text-link" href="/billing">차감 단가 · 충전 및 이용 내역</a><h3>판매자 정보</h3><p>{data.business.name} · 대표자 {data.business.representative}</p><p>사업자등록번호: {data.business.registrationNumber || '등록 준비 중'}</p><p>사업장 주소: {data.business.address || '등록 준비 중'}</p><p>고객지원: {data.business.supportEmail || '등록 준비 중'}</p></div></details>
          <a className="prism-upgrade-chat-link" href="/chat"><ArrowLeft size={16} aria-hidden="true" />Prism 채팅으로 돌아가기</a>
        </div>
      </>}
    {data && <PlanDialog open={plansOpen} products={data.products} selectedId={selected?.id} foregroundOpen={termsOpen} returnFocus={opener}
      onOpenChange={open => { setPlansOpen(open); if (!open) setTermsOpen(false); }}
      onChoose={(product, trigger) => { setSelected(product); selectedTrigger.current = trigger; setTermsOpen(true); }}>
      <TermsDialog open={termsOpen} data={data} product={selected} returnFocus={selectedTrigger} onOpenChange={setTermsOpen} onContinue={continueFromTerms} />
    </PlanDialog>}
  </UpgradeShell>;
}
