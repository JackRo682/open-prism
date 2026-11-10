/** Browser-safe billing contracts. Amounts on products/orders are integer KRW;
 * wallet balances are integer millionths of KRW. No credentials belong here. */
export type PaymentMode = 'disabled' | 'test' | 'live';
export type ActivePaymentMode = Exclude<PaymentMode, 'disabled'>;
export type PaymentState = 'pending' | 'paid' | 'partially_refunded' | 'refunded' | 'expired' | 'failed' | 'review';
export type BillingProduct = {
  id: string;
  name: string;
  description: string;
  amount: number;
  currency: 'KRW';
};
export type BillingTerms = {
  version: string;
  policyHash: string;
  refundPolicy: string;
  validityPolicy: string;
};
export type BillingBusiness = {
  name: string;
  representative: string;
  registrationNumber: string;
  address: string;
  supportEmail: string;
};
export type UpgradeOverview = {
  signedIn: boolean;
  beta: boolean;
  mode: PaymentMode;
  checkoutAvailable: boolean;
  products: BillingProduct[];
  terms: BillingTerms;
  business: BillingBusiness;
  balance: number | null;
  testBalance: number | null;
};
export type PaymentOrder = {
  orderId: string;
  orderName: string;
  productId: string;
  amount: number;
  currency: 'KRW';
  mode: ActivePaymentMode;
  clientKey: string;
  customerKey: string;
  checkoutKind: 'widget' | 'payment';
};
export type PaymentStatus = {
  ok: true;
  orderId: string;
  orderName: string;
  productId: string | null;
  amount: number;
  currency: 'KRW';
  mode: ActivePaymentMode;
  status: PaymentState;
  refundedAmount: number;
  pendingRefundAmount: number;
  balance: number;
  createdAt: number;
  paidAt: number | null;
  canReconcile: boolean;
};

// These are the existing one-off credit products, not subscriptions. Prices
// are enforced again on the server and snapshotted when an order is created.
export const BILLING_PRODUCTS: readonly BillingProduct[] = [
  { id: 'credits-10000', name: 'Prism AI 크레딧 1만원', description: '필요한 만큼 시작하세요. 실제 사용량에 따라 차감됩니다.', amount: 10_000, currency: 'KRW' },
  { id: 'credits-30000', name: 'Prism AI 크레딧 3만원', description: '일상의 작업을 이어가세요. 실제 사용량에 따라 차감됩니다.', amount: 30_000, currency: 'KRW' },
  { id: 'credits-50000', name: 'Prism AI 크레딧 5만원', description: '더 많은 작업을 준비하세요. 실제 사용량에 따라 차감됩니다.', amount: 50_000, currency: 'KRW' },
];
export const BILLING_TERMS_VERSION = '2026-11-07.1';
