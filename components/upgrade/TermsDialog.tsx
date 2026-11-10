'use client';

import type { RefObject } from 'react';
import { Dialog } from 'radix-ui';
import type { BillingProduct, UpgradeOverview } from '../../lib/billing-contract';
import { formatWon, upgradeSignInHref } from './api';

export function TermsDialog({ open, data, product, returnFocus, onOpenChange, onContinue }: {
  open: boolean;
  data: UpgradeOverview;
  product: BillingProduct | null;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
}) {
  const returnPath = product ? `/upgrade?product=${encodeURIComponent(product.id)}` : '/upgrade';
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="prism-upgrade-overlay prism-upgrade-terms-overlay" />
      <Dialog.Content className="prism-upgrade-dialog prism-upgrade-terms-dialog"
        onCloseAutoFocus={event => { event.preventDefault(); if (!open) returnFocus.current?.focus(); }}>
        <Dialog.Title className="prism-upgrade-dialog-title">GetOpenPrism 서비스 약관</Dialog.Title>
        <Dialog.Description className="prism-upgrade-sr-only">선택한 크레딧의 결제 금액과 구매 조건을 확인하세요. 결제가 가능한 경우 동의하고 계속을 누르면 이 조건에 대한 동의가 주문에 기록됩니다.</Dialog.Description>
        <div className="prism-upgrade-dialog-scroll prism-upgrade-terms-copy">
          <p>{product ? <><strong>{product.name}</strong>을 <strong>{formatWon(product.amount)}</strong>에 한 번 충전합니다. </> : null}월 구독 및 자동 갱신은 없습니다.</p>
          <p>구매를 진행하면 <a href="/terms" target="_blank" rel="noopener noreferrer">GetOpenPrism 서비스 약관</a>과 아래 구매 조건에 동의합니다. 개인정보 처리 방식은 <a href="/privacy" target="_blank" rel="noopener noreferrer">개인정보처리방침</a>에서 확인할 수 있습니다.</p>
          <p><strong>환불 기준</strong><br />{data.terms.refundPolicy || '환불 기준을 준비하고 있습니다. 기준이 확정되기 전에는 실제 결제를 진행할 수 없습니다.'}</p>
          <p><strong>유효기간</strong><br />{data.terms.validityPolicy || '크레딧 유효기간을 준비하고 있습니다. 유효기간이 확정되기 전에는 실제 결제를 진행할 수 없습니다.'}</p>
          <p>모델별 실제 사용량에 따라 잔액이 차감되며, 제공되는 모델과 기능은 서비스의 이용 가능 상태에 따라 달라집니다. <a href="/billing" target="_blank" rel="noopener noreferrer">차감 단가와 이용 내역 확인</a></p>
          {data.mode === 'test' && <p className="prism-upgrade-mode-note">테스트 결제입니다. 실제 금액은 청구되지 않으며 테스트 잔액은 AI 이용에 사용할 수 없습니다.</p>}
          {!data.checkoutAvailable && <p className="prism-upgrade-mode-note">충전 서비스를 준비하고 있습니다. 지금은 구매 조건을 확인할 수 있으며, 결제나 동의 기록 저장은 진행되지 않습니다.</p>}
        </div>
        <div className="prism-upgrade-dialog-actions">
          <Dialog.Close className="prism-upgrade-text-button">취소</Dialog.Close>
          {data.checkoutAvailable && !data.signedIn ?
            <a className="prism-upgrade-text-button" href={upgradeSignInHref(returnPath)} target="_top">로그인하고 계속</a> :
            <button className="prism-upgrade-text-button" onClick={onContinue}>{data.checkoutAvailable ? '동의하고 계속' : '확인'}</button>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
