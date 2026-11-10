/** Types for the subset of Toss Payments SDK v2 used by this application. */
export type TossAgreementStatus = { agreedRequiredTerms: boolean };
export type TossWidgetControl = { destroy: () => void | Promise<void> };
export type TossAgreementControl = TossWidgetControl & {
  on: (event: 'agreementStatusChange', listener: (status: TossAgreementStatus) => void) => void;
};
type PaymentUrls = { orderId: string; orderName: string; successUrl: string; failUrl: string };
export type TossWidgets = {
  setAmount: (amount: { currency: 'KRW'; value: number }) => Promise<void>;
  renderPaymentMethods: (options: { selector: string; variantKey: string }) => Promise<TossWidgetControl>;
  renderAgreement: (options: { selector: string; variantKey: string }) => Promise<TossAgreementControl>;
  requestPayment: (options: PaymentUrls) => Promise<void>;
};
export type TossPayment = {
  requestPayment: (options: PaymentUrls & { method: 'CARD'; amount: { currency: 'KRW'; value: number } }) => Promise<void>;
};
export type TossFactory = (clientKey: string) => {
  widgets: (options: { customerKey: string }) => TossWidgets;
  payment: (options: { customerKey: string }) => TossPayment;
};

let pending: Promise<TossFactory> | undefined;
const factory = () => {
  const candidate = (window as Window & { TossPayments?: TossFactory }).TossPayments;
  return typeof candidate === 'function' ? candidate : undefined;
};

/** Called only after an authenticated server-created order supplies a public key. */
export function loadTossPayments(): Promise<TossFactory> {
  if (typeof window === 'undefined') return Promise.reject(new Error('결제는 브라우저에서 진행해 주세요.'));
  const loaded = factory();
  if (loaded) return Promise.resolve(loaded);
  if (pending) return pending;
  pending = new Promise<TossFactory>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://js.tosspayments.com/v2/standard';
    script.async = true;
    script.dataset.prismToss = 'v2';
    script.referrerPolicy = 'no-referrer';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      const loadedFactory = factory();
      if (error || !loadedFactory) {
        script.remove();
        reject(error || new Error('결제 서비스를 불러오지 못했습니다. 다시 시도해 주세요.'));
      } else resolve(loadedFactory);
    };
    const timeout = setTimeout(() => finish(new Error('결제 서비스 연결 시간이 초과되었습니다. 다시 시도해 주세요.')), 20_000);
    script.onload = () => finish();
    script.onerror = () => finish(new Error('결제 서비스를 불러오지 못했습니다. 네트워크 연결을 확인해 주세요.'));
    document.head.appendChild(script);
  }).catch(error => { pending = undefined; throw error; });
  return pending;
}

export function isTossCancellation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    ['USER_CANCEL', 'PAY_PROCESS_CANCELED'].includes(String(error.code));
}
