'use client';

import { useEffect, useRef, useState } from 'react';
import { clearGuestSession, readGuestSession } from '../../lib/guest-session';

type ImportableSession = { id: string; messages: { role: 'user' | 'assistant'; content: string }[] };

export function GuestImportNotice({ onImported }: { onImported: (conversationId: string) => void }) {
  const [session, setSession] = useState<ImportableSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const aborter = useRef<AbortController | null>(null);
  const imported = useRef(onImported);
  imported.current = onImported;

  useEffect(() => {
    const stored = readGuestSession();
    if (stored) {
      const complete: ImportableSession['messages'] = [];
      for (let index = 0; index + 1 < stored.messages.length; index += 2) {
        const question = stored.messages[index], answer = stored.messages[index + 1];
        if (question.role !== 'user' || answer.role !== 'assistant' || !question.content.trim() || !answer.content.trim() || answer.status !== 'complete') continue;
        complete.push({ role: 'user', content: question.content }, { role: 'assistant', content: answer.content });
      }
      if (complete.length) setSession({ id: stored.id, messages: complete });
    }
    return () => aborter.current?.abort();
  }, []);

  async function save() {
    if (!session || pending.current) return;
    pending.current = true;
    setBusy(true); setError('');
    const controller = new AbortController(); aborter.current = controller;
    try {
      const response = await fetch('/api/conversations/import-guest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ sessionId: session.id, messages: session.messages }),
      });
      const result = await response.json() as { conversationId?: string; error?: string };
      if (!response.ok || !result.conversationId) throw new Error(result.error || '대화를 저장하지 못했습니다. 다시 시도해 주세요.');
      if (controller.signal.aborted) return;
      clearGuestSession(); setSession(null); imported.current(result.conversationId);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '대화를 저장하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      pending.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  if (!session) return null;
  return <section className="prism-guest-import" aria-labelledby="guest-import-title">
    <strong id="guest-import-title">로그인 전 대화를 이어서 저장할까요?</strong>
    <p>이 탭에서 나눈 {session.messages.length / 2}개의 질문과 응답을 현재 계정의 대화 기록에 저장합니다. 저장하지 않아도 새 대화를 시작할 수 있습니다.</p>
    {error ? <p role="alert">{error}</p> : null}
    <div className="prism-guest-import-actions">
      <button type="button" disabled={busy} onClick={() => { clearGuestSession(); setSession(null); }}>저장하지 않기</button>
      <button type="button" disabled={busy} onClick={() => void save()}>{busy ? '저장 중…' : '저장하고 이어가기'}</button>
    </div>
  </section>;
}
