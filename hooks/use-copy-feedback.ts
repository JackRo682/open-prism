'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type CopiedItem = {
  id: string;
  text: string;
  scope: string;
  notice: string;
  sequence: number;
};

const COPY_FEEDBACK_DURATION = 2500;
const COPY_ERROR = '복사하지 못했습니다. 텍스트를 선택해 직접 복사해 주세요.';

/** Keep button and toast feedback tied to the clipboard write that succeeded. */
export function useCopyFeedback(scope: string, onError: (message: string) => void, resolveText: (id: string) => string | undefined) {
  const [copied, setCopied] = useState<CopiedItem | null>(null);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentScope = useRef(scope);
  const currentText = useRef(resolveText);
  currentScope.current = scope;
  currentText.current = resolveText;

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const resetCopyFeedback = useCallback(() => {
    sequence.current++;
    clearTimer();
    setCopied(null);
  }, [clearTimer]);

  useEffect(() => {
    resetCopyFeedback();
    return () => {
      sequence.current++;
      clearTimer();
    };
  }, [scope, resetCopyFeedback, clearTimer]);

  const copy = useCallback(async (id: string, text: string, notice = '대화가 복사되었습니다.') => {
    const request = ++sequence.current;
    clearTimer();
    setCopied(null);
    try {
      await navigator.clipboard.writeText(text);
      // A later click, navigation, or unmount makes this result obsolete.
      if (request !== sequence.current || scope !== currentScope.current || currentText.current(id) !== text) return false;
      setCopied({ id, text, scope, notice, sequence: request });
      timer.current = setTimeout(() => {
        timer.current = null;
        setCopied(null);
      }, COPY_FEEDBACK_DURATION);
      return true;
    } catch {
      if (request === sequence.current && scope === currentScope.current && currentText.current(id) === text) onError(COPY_ERROR);
      return false;
    }
  }, [scope, onError, clearTimer]);

  const current = copied?.scope === scope && resolveText(copied.id) === copied.text ? copied : null;
  return {
    copy,
    // Editing/regenerating content must never retain a stale success check.
    isCopied: (id: string, text: string) => current?.id === id && current.text === text,
    copyNotice: current?.notice || '',
    copyNoticeKey: current?.sequence,
    resetCopyFeedback,
  };
}
