'use client';

import type { ReactNode } from 'react';
import { CircleHelp, UserRound } from 'lucide-react';
import { upgradeSignInHref } from './api';
import { PrismMark } from '../brand/prism-mark';

export function UpgradeShell({ children, signedIn, signInHref, signInTarget = '_top' }: { children: ReactNode; signedIn?: boolean; signInHref?: string; signInTarget?: '_top' | '_blank' }) {
  return <div className="prism-upgrade-shell">
    <a className="prism-upgrade-skip" href="#upgrade-content">본문으로 이동</a>
    <header className="prism-upgrade-header">
      <a className="prism-upgrade-brand" href="/chat" aria-label="Prism 채팅으로 돌아가기">
        <PrismMark size={28}/><span>Prism</span>
      </a>
      <nav className="prism-upgrade-header-actions" aria-label="계정 및 도움말">
        <a className="prism-upgrade-icon" href="/faq" aria-label="도움말" title="도움말"><CircleHelp size={22} aria-hidden="true" /></a>
        {signedIn === undefined ? <span className="prism-upgrade-avatar-placeholder" aria-hidden="true" /> : signedIn ?
          <a className="prism-upgrade-account" href="/settings" aria-label="계정 설정" title="계정 설정"><UserRound size={21} aria-hidden="true" /></a> :
          <a className="prism-upgrade-signin" href={signInHref || upgradeSignInHref()} target={signInTarget} rel="noopener noreferrer">로그인</a>}
      </nav>
    </header>
    <main id="upgrade-content" className="prism-upgrade-main">{children}</main>
    <footer className="prism-upgrade-footer">
      <span>GetOpenPrism</span>
      <a href="/terms" target="_blank" rel="noopener noreferrer">서비스 약관</a>
      <a href="/privacy" target="_blank" rel="noopener noreferrer">개인정보처리방침</a>
      <a href="/faq" target="_blank" rel="noopener noreferrer">도움말</a>
    </footer>
  </div>;
}
