'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

export default function GuestDialog({ title, children, onClose, className = '', returnFocus, descriptionId }: { title: string; children: ReactNode; onClose: () => void; className?: string; returnFocus?: HTMLElement | null; descriptionId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = returnFocus || document.activeElement as HTMLElement | null;
    const node = ref.current;
    const timer = window.setTimeout(() => {
      (node?.querySelector<HTMLElement>('[data-initial-focus]') ?? node)?.focus();
    }, 0);
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab' || !node) return;
      const elements = [...node.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex="0"]')].filter(element => element.getClientRects().length);
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); node.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return <div className="pg-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`pg-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={headingId} aria-describedby={descriptionId} tabIndex={-1} ref={ref}>
      <h2 id={headingId}>{title}</h2>
      {children}
    </div>
  </div>;
}
