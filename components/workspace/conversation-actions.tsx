'use client';

import { useRef, type ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
import { Download, FileText, MoreVertical, PenLine, Pin, PinOff, Share2, Trash2 } from 'lucide-react';
import { useIsMobile } from '../../hooks/use-mobile';
import './conversation-actions.css';

export type ConversationActionsProps = {
  title: string;
  onRename(): void;
  onDelete(): void;
  onPin?(): void | Promise<void>;
  isPinned?: boolean;
  onDownloadPdf?(): void | Promise<void>;
  onExportDocs?(): void | Promise<void>;
  onShare?(): void;
  shareDisabled?: boolean;
  exportBusy?: boolean;
  className?: string;
  variant?: 'sidebar' | 'header';
  disabled?: boolean;
  children?: ReactNode;
};

/** Shared conversation menu; each trigger stays separate from the chat link. */
export function ConversationActions({
  title,
  onRename,
  onDelete,
  onPin,
  isPinned = false,
  onDownloadPdf,
  onExportDocs,
  onShare,
  shareDisabled = false,
  exportBusy = false,
  className = '',
  variant = 'sidebar',
  disabled = false,
  children,
}: ConversationActionsProps) {
  const isMobile = useIsMobile();
  // Mobile needs horizontal collision shifting to stay at the viewport's right
  // edge; a right-side popup would instead flip entirely left of the trigger.
  const menuSide = variant === 'header' || isMobile ? 'bottom' : 'right';
  const menuAlign = variant === 'header' || isMobile ? 'end' : 'start';
  const triggerRef = useRef<HTMLButtonElement>(null);
  const handingOffFocus = useRef(false);

  function openDialog(action: () => void) {
    // Let the confirmation/rename dialog own focus, and give it a stable return target.
    handingOffFocus.current = true;
    triggerRef.current?.focus();
    action();
  }

  return <DropdownMenu.Root modal={false}>
    <DropdownMenu.Trigger asChild>
      <button
        ref={triggerRef}
        type="button"
        className={`prism-conversation-menu-trigger prism-conversation-menu-trigger--${variant}${className ? ' ' + className : ''}`}
        aria-label={`${variant === 'header' ? '현재 대화' : '대화'} 메뉴: ${title}`}
        title="대화 메뉴"
        disabled={disabled}
        onClick={event => event.stopPropagation()}
      >
        <MoreVertical size={19} aria-hidden="true"/>
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        className={`prism-conversation-menu prism-conversation-menu--${variant}`}
        aria-label={`${title} 대화 관리`}
        side={menuSide}
        align={menuAlign}
        sideOffset={8}
        collisionPadding={12}
        loop
        onCloseAutoFocus={event => {
          if (handingOffFocus.current) {
            event.preventDefault();
            handingOffFocus.current = false;
          }
        }}
      >
        {onPin && <DropdownMenu.Item className="prism-conversation-menu-item" onSelect={() => { void onPin(); }}>
          {isPinned ? <PinOff size={18} aria-hidden="true"/> : <Pin size={18} aria-hidden="true"/>}<span>{isPinned ? '고정 해제' : '고정'}</span>
        </DropdownMenu.Item>}
        <DropdownMenu.Item className="prism-conversation-menu-item" onSelect={() => openDialog(onRename)}>
          <PenLine size={18} aria-hidden="true"/><span>이름 변경</span>
        </DropdownMenu.Item>
        {onShare && <DropdownMenu.Item className="prism-conversation-menu-item" disabled={shareDisabled} onSelect={() => openDialog(onShare)}>
          <Share2 size={18} aria-hidden="true"/><span>대화 공유</span>
        </DropdownMenu.Item>}
        {onDownloadPdf && <DropdownMenu.Item className="prism-conversation-menu-item" disabled={exportBusy} onSelect={() => { void onDownloadPdf(); }}>
          <Download size={18} aria-hidden="true"/><span>PDF로 저장</span>
        </DropdownMenu.Item>}
        {onExportDocs && <DropdownMenu.Item className="prism-conversation-menu-item" disabled={exportBusy} onSelect={() => { void onExportDocs(); }}>
          <FileText size={18} aria-hidden="true"/><span>Docs로 내보내기</span>
        </DropdownMenu.Item>}
        {children}
        <DropdownMenu.Item className="prism-conversation-menu-item prism-conversation-menu-item--danger" onSelect={() => openDialog(onDelete)}>
          <Trash2 size={18} aria-hidden="true"/><span>삭제</span>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
