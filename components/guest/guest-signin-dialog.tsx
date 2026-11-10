'use client';

import type { GuestSignInReminderReason } from '../../lib/guest-signin-reminder';
import GuestDialog from './guest-dialog';

export default function GuestSignInDialog({ reason, signInHref, onSignIn, onClose, returnFocus }: {
  reason: GuestSignInReminderReason;
  signInHref: string;
  onSignIn: () => void;
  onClose: () => void;
  returnFocus: HTMLElement | null;
}) {
  const exhausted = reason === 'limit';
  return <GuestDialog returnFocus={returnFocus} title={exhausted ? '로그인하여 계속 이용하세요' : '로그인하고 더 많은 기능을 이용하세요'} onClose={onClose} className="pg-signin-dialog" descriptionId="pg-signin-description">
    <p id="pg-signin-description">{exhausted ? '오늘의 비로그인 체험 횟수를 모두 사용했습니다. 로그인하고 대화를 저장하거나 더 많은 기능을 이용하세요.' : '대화를 저장하고 파일을 추가하거나 이미지를 만드는 등 다양한 기능을 이용하세요.'}</p>
    <div className="pg-dialog-actions">
      <button type="button" data-initial-focus className="pg-dialog-cancel" onClick={onClose}>{exhausted ? '닫기' : '나중에'}</button>
      <a className="pg-dialog-signin" href={signInHref} target="_top" onClick={onSignIn}>로그인</a>
    </div>
  </GuestDialog>;
}
