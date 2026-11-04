'use client';

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Dialog } from 'radix-ui';
import { ExternalLink, Globe2 } from 'lucide-react';
import {
  BROWSER_PREFERENCES_EVENT,
  BROWSER_PREFERENCES_KEY,
  readLocalBrowserPreferences,
  type BrowserPreferences,
} from './browser-settings';

type PendingLink = { href: string; origin: string; remote: boolean };

const defaultPreferences = (): BrowserPreferences => ({
  browserTarget: 'current',
  browserPermission: 'ask',
});

function readPreferences(value: unknown): BrowserPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultPreferences();
  const input = value as Record<string, unknown>;
  return {
    browserTarget: input.browserTarget === 'remote' ? 'remote' : 'current',
    browserPermission: input.browserPermission === 'approve' ? 'approve' : 'ask',
  };
}

function isAuthenticationLink(anchor: HTMLAnchorElement, url: URL) {
  if (anchor.hasAttribute('data-prism-auth-link')) return true;
  if (url.hostname === 'auth.openai.com' || url.hostname === 'auth.chatgpt.com') return true;
  return url.hostname === 'chatgpt.com' && /^\/(?:auth|oauth|api\/auth)(?:\/|$)/.test(url.pathname);
}

/** Applies the saved preference to user-activated external anchors only. */
export function BrowserLinkGuard({ signedIn }: { signedIn: boolean }) {
  const preferences = useRef<BrowserPreferences>(defaultPreferences());
  const trigger = useRef<HTMLElement | null>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [pending, setPending] = useState<PendingLink | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let revision = 0;
    preferences.current = signedIn ? defaultPreferences() : readLocalBrowserPreferences();
    setPending(null);

    const adoptPreferences = (value: unknown) => {
      revision += 1;
      preferences.current = readPreferences(value);
    };
    const onPreferencesChanged = (event: Event) => {
      if (event instanceof CustomEvent) adoptPreferences(event.detail);
    };
    const onStorageChanged = (event: StorageEvent) => {
      if (!signedIn && (event.key === BROWSER_PREFERENCES_KEY || event.key === null)) {
        adoptPreferences(readLocalBrowserPreferences());
      }
    };

    const onAnchorClick = (event: MouseEvent) => {
      // Keyboard activations produce trusted primary clicks too. Programmatic
      // routing, right clicks, and non-anchor UI actions retain their behavior.
      if (!event.isTrusted || event.defaultPrevented) return;
      if (event.type === 'auxclick' ? event.button !== 1 : event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('button, input, textarea, select')) return;
      const anchor = event.composedPath().find((entry) => entry instanceof HTMLAnchorElement)
        || target?.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)
        || anchor.hasAttribute('download')
        || anchor.hasAttribute('data-prism-confirmed-link')) return;

      let url: URL;
      try { url = new URL(anchor.href, window.location.href); }
      catch { return; }
      if (!['http:', 'https:'].includes(url.protocol)
        || url.origin === window.location.origin
        || isAuthenticationLink(anchor, url)) return;

      const current = preferences.current;
      if (current.browserTarget === 'current' && current.browserPermission === 'approve') return;

      event.preventDefault();
      event.stopPropagation();
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      trigger.current = anchor;
      setPending({ href: url.href, origin: url.origin, remote: current.browserTarget === 'remote' });
    };

    window.addEventListener(BROWSER_PREFERENCES_EVENT, onPreferencesChanged);
    window.addEventListener('storage', onStorageChanged);
    document.addEventListener('click', onAnchorClick, true);
    document.addEventListener('auxclick', onAnchorClick, true);

    if (signedIn) {
      const requestRevision = revision;
      fetch('/api/settings', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) throw new Error('Preferences unavailable.');
        const data: unknown = await response.json();
        if (!controller.signal.aborted && revision === requestRevision) adoptPreferences(data);
      }).catch(() => {
        if (!controller.signal.aborted && revision === requestRevision) {
          preferences.current = defaultPreferences();
        }
      });
    }

    return () => {
      controller.abort();
      window.removeEventListener(BROWSER_PREFERENCES_EVENT, onPreferencesChanged);
      window.removeEventListener('storage', onStorageChanged);
      document.removeEventListener('click', onAnchorClick, true);
      document.removeEventListener('auxclick', onAnchorClick, true);
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    };
  }, [signedIn]);

  function closeAfterNavigation(event: ReactMouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || (event.type === 'auxclick' && event.button !== 1)) return;
    // Keep the real anchor mounted through its native navigation. This retains
    // popup permissions and avoids opening a window from an asynchronous task.
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setPending(null);
    }, 0);
  }

  return (
    <Dialog.Root open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="prism-dialog-overlay" />
        <Dialog.Content
          className="prism-confirm-dialog prism-link-guard-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelButton.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const returnTarget = trigger.current?.isConnected
              ? trigger.current : document.querySelector<HTMLElement>('.gemini-brand');
            returnTarget?.focus({ preventScroll: true });
            trigger.current = null;
          }}
        >
          <Globe2 className="prism-link-guard-icon" size={26} aria-hidden="true" />
          <Dialog.Title>{pending?.remote ? '원격 브라우저가 연결되지 않았습니다' : '외부 링크를 열까요?'}</Dialog.Title>
          <Dialog.Description>
            {pending?.remote
              ? '이 링크는 원격 브라우저로 열 수 없습니다. 현재 브라우저에서 직접 열 수 있습니다.'
              : '아래 사이트를 현재 브라우저의 새 탭에서 엽니다.'}
          </Dialog.Description>
          {pending && <div className="prism-link-guard-destination" dir="ltr">
            <strong>{pending.origin}</strong>
            <span>{pending.href}</span>
          </div>}
          <div className="prism-setting-actions">
            <Dialog.Close asChild><button ref={cancelButton} type="button" className="prism-action-button">취소</button></Dialog.Close>
            {pending && <a
              className="prism-action-button primary"
              href={pending.href}
              target="_blank"
              rel="noopener noreferrer"
              data-prism-confirmed-link="true"
              onClick={closeAfterNavigation}
              onAuxClick={closeAfterNavigation}
            >{pending.remote ? '현재 브라우저로 열기' : '링크 열기'}<ExternalLink size={15} aria-hidden="true" /></a>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
