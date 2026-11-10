'use client';

import type { ReactNode, RefObject } from 'react';
import { Dialog } from 'radix-ui';
import type { BillingProduct } from '../../lib/billing-contract';
import { formatWon } from './api';

type PlanDialogProps = {
  open: boolean;
  products: BillingProduct[];
  selectedId?: string;
  foregroundOpen: boolean;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
  onChoose: (product: BillingProduct, trigger: HTMLButtonElement) => void;
  children: ReactNode;
};

export function PlanDialog({ open, products, selectedId, foregroundOpen, returnFocus, onOpenChange, onChoose, children }: PlanDialogProps) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="prism-upgrade-overlay" />
      <Dialog.Content className="prism-upgrade-dialog prism-upgrade-plan-dialog"
        onInteractOutside={event => { if (foregroundOpen) event.preventDefault(); }}
        onEscapeKeyDown={event => { if (foregroundOpen) event.preventDefault(); }}
        onCloseAutoFocus={event => { event.preventDefault(); returnFocus.current?.focus(); }}>
        <Dialog.Title className="prism-upgrade-dialog-title">충전 금액을 선택하세요</Dialog.Title>
        <Dialog.Description className="prism-upgrade-sr-only">월 구독 없이 한 번 충전하는 AI 크레딧입니다. 금액을 선택하면 구매 조건을 확인할 수 있습니다.</Dialog.Description>
        <div className="prism-upgrade-dialog-scroll">
          <div className="prism-upgrade-options">
            {products.map(product => <article className="prism-upgrade-option" key={product.id} data-selected={selectedId === product.id || undefined}>
              <div className="prism-upgrade-option-description"><h3>{product.name}</h3><p>{product.description}</p></div>
              <div className="prism-upgrade-option-bottom"><p className="prism-upgrade-option-price">{formatWon(product.amount)}<span> / 1회</span></p>
                <button className="prism-upgrade-button prism-upgrade-option-choose" onClick={event => onChoose(product, event.currentTarget)} aria-label={`${product.name} 선택`}>이 금액 충전</button>
              </div>
            </article>)}
          </div>
          <p className="prism-upgrade-fineprint">자동 갱신 없이 선택한 금액만 결제합니다. 모델별 차감 단가와 환불 기준, 유효기간은 구매 전 확인해 주세요.</p>
        </div>
        <div className="prism-upgrade-dialog-actions"><Dialog.Close className="prism-upgrade-text-button">닫기</Dialog.Close></div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
