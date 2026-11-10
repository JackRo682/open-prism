'use client';

import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import './deferred-panel.css';

type DeferredPanelProps = {
  children: ReactNode;
  label?: string;
  dialog?: boolean;
  onClose?(): void;
  fallback?: ReactNode;
  resetKey?: string;
};

function PanelState({ label = '화면', dialog = false, onClose, failed = false }: Omit<DeferredPanelProps, 'children' | 'fallback'> & { failed?: boolean }) {
  const content = <div className="prism-deferred-panel" aria-busy={!failed}>
    <p role={failed ? 'alert' : 'status'}>{failed ? '선택한 화면을 불러오지 못했습니다. 연결을 확인한 후 다시 불러와 주세요.' : `${label} 불러오는 중…`}</p>
    {failed
      ? <button type="button" className="prism-secondary-button" onClick={() => window.location.reload()}>새로고침하여 다시 불러오기</button>
      : <div className="prism-deferred-skeleton" aria-hidden="true"><i/><i/><i/></div>}
  </div>;

  if (!dialog) return content;
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose?.(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="prism-dialog-overlay"/>
      <Dialog.Content className="prism-dialog-content prism-deferred-dialog" onCloseAutoFocus={event => event.preventDefault()}>
        <Dialog.Title>{label}</Dialog.Title>
        <Dialog.Description className="sr-only">{failed ? '화면을 불러오지 못했습니다.' : '선택한 기능을 준비하고 있습니다.'}</Dialog.Description>
        {content}
        {onClose && <Dialog.Close className="prism-secondary-button">닫기</Dialog.Close>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

class PanelErrorBoundary extends Component<DeferredPanelProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: DeferredPanelProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (this.state.failed) return <PanelState label={this.props.label} dialog={this.props.dialog} onClose={this.props.onClose} failed/>;
    return this.props.children;
  }
}

/** Keep optional features out of the first load without ever blanking the shell. */
export function DeferredPanel({ children, fallback, resetKey, ...props }: DeferredPanelProps) {
  // Capture before a loading dialog can take focus. The actual dialog may be
  // downloaded later and would otherwise remember the temporary loading UI.
  const [returnFocus] = useState<HTMLElement | null>(() => {
    if (!props.dialog || typeof document === 'undefined') return null;
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });
  const focusLifetime = useRef(0);
  useEffect(() => {
    if (!props.dialog) return;
    const lifetime = ++focusLifetime.current;
    return () => {
      // The wrapper survives the Suspense swap; only closing the whole feature
      // restores its trigger. Wait for the loaded dialog's own focus cleanup.
      window.requestAnimationFrame(() => {
        if (focusLifetime.current !== lifetime || !returnFocus?.isConnected) return;
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body && active !== document.documentElement && active.isConnected) return;
        returnFocus.focus({ preventScroll: true });
      });
    };
  }, [props.dialog, returnFocus]);

  return <PanelErrorBoundary {...props} resetKey={resetKey}>
    <Suspense fallback={fallback ?? <PanelState {...props}/>}>{children}</Suspense>
  </PanelErrorBoundary>;
}
