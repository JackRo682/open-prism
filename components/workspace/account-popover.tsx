'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Popover } from 'radix-ui';
import { ArrowUpRight, LogIn, LogOut, ShieldCheck, X } from 'lucide-react';

type AccountPopoverProps = {
  user: { name: string; email: string } | null;
  beta?: boolean;
  walletBalance: number | null;
  pathname: string;
  signInHref: string;
  onSignIn(): void;
  onNavigate(path: string): void;
};

/** Account details stay above the sidebar profile until an action is chosen. */
export function AccountPopover({ user, beta, walletBalance, pathname, signInHref, onSignIn, onNavigate }: AccountPopoverProps) {
  const [open, setOpen] = useState(false);
  const previousPathname = useRef(pathname);
  const titleId = useId();
  const initial = user?.name?.[0]?.toUpperCase() || 'P';
  const planLabel = !user ? '로그인' : walletBalance === null
    ? '잔액 확인 중'
    : '잔액 ' + new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(walletBalance / 1e6) + '원';

  useEffect(() => {
    // Do not dismiss the first interaction replayed during hydration.
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    setOpen(false);
  }, [pathname]);

  function navigate(path: string) {
    setOpen(false);
    onNavigate(path);
  }

  return <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
    <Popover.Trigger asChild>
      <button type="button" className="gemini-account" aria-label="계정 메뉴" title={user?.name || 'Prism 계정'}>
        <span className="gemini-avatar" aria-hidden="true">{initial}</span>
        <span><strong>{user?.name || 'Prism'}</strong><small>{planLabel}</small></span>
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        className="prism-account-popover"
        side="top"
        align="start"
        sideOffset={10}
        alignOffset={-2}
        collisionPadding={12}
        aria-labelledby={titleId}
        aria-describedby={undefined}
      >
        <div className="prism-account-popover-head">
          <h2 id={titleId} className="prism-visually-hidden">계정 및 설정</h2>
          <Popover.Close className="prism-account-close" aria-label="계정 메뉴 닫기"><X size={21} aria-hidden="true"/></Popover.Close>
        </div>
        <div className="prism-account-identity">
          <span className="prism-account-avatar" aria-hidden="true">{initial}</span>
          <div className="prism-account-details">
            <strong title={user?.name}>{user?.name || 'Prism'}</strong>
            <p title={user?.email}>{user?.email || '로그인하고 대화를 이어가세요.'}</p>
            {user && <div className="prism-account-plan-row">
              <span className="prism-account-plan">{planLabel}</span>
              <button type="button" className="prism-account-upgrade" onClick={() => navigate('/upgrade')}>업그레이드<ArrowUpRight size={13} aria-hidden="true"/></button>
            </div>}
          </div>
        </div>
        <div className="prism-account-actions">
          {user ? <>
            <button type="button" className="prism-account-action" onClick={() => navigate('/settings')}><ShieldCheck size={21} aria-hidden="true"/><span>Prism 계정 관리</span></button>
            <a className="prism-account-action" href="/signout-with-chatgpt?return_to=%2F" target="_top" data-prism-auth-link onClick={onSignIn}><LogOut size={21} aria-hidden="true"/><span>로그아웃</span></a>
          </> : <>
            <a className="prism-account-action" href={signInHref} target="_top" data-prism-auth-link onClick={onSignIn}><LogIn size={21} aria-hidden="true"/><span>ChatGPT로 로그인</span></a>
            <button type="button" className="prism-account-action" onClick={() => navigate('/faq')}><ShieldCheck size={21} aria-hidden="true"/><span>Prism 이용 안내</span></button>
          </>}
        </div>
        <div className="prism-account-footer">
          <button type="button" onClick={() => navigate('/privacy')}>개인정보처리방침</button>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={() => navigate('/terms')}>서비스 약관</button>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
