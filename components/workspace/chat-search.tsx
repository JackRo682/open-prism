'use client';

import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { AlertCircle, LoaderCircle, MessageSquare, Search, X } from 'lucide-react';

type SearchResult = {
  id: string;
  title: string;
  model?: string;
  updated_at: number;
  snippet?: string;
};

export interface ChatSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (path: string) => void;
  signedIn: boolean;
}

export function ChatSearchDialog({ open, onOpenChange, onNavigate, signedIn }: ChatSearchDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open || !signedIn) {
      setResults([]);
      setError('');
      setPending(false);
      return;
    }
    const controller = new AbortController();
    setPending(true);
    setError('');
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        const data = await response.json() as { results?: SearchResult[]; error?: string };
        if (!response.ok) throw new Error(data.error || '검색 결과를 불러오지 못했습니다.');
        if (!Array.isArray(data.results)) throw new Error('검색 응답을 읽을 수 없습니다. 다시 시도해 주세요.');
        if (!controller.signal.aborted) setResults(data.results);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setResults([]);
          setError(cause instanceof Error ? cause.message : '검색 결과를 불러오지 못했습니다.');
        }
      } finally {
        if (!controller.signal.aborted) setPending(false);
      }
    }, query.trim() ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, signedIn, query, attempt]);

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setQuery('');
  };

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="prism-dialog-overlay" />
        <Dialog.Content
          className="prism-search-dialog"
          onOpenAutoFocus={(event) => {
            returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <Dialog.Title className="prism-visually-hidden">채팅 검색</Dialog.Title>
          <Dialog.Description className="prism-visually-hidden">내 대화의 제목과 메시지를 검색합니다.</Dialog.Description>
          <div className="prism-search-head">
            <Search size={21} aria-hidden="true" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  resultRef.current?.querySelector<HTMLButtonElement>('.prism-search-result')?.focus();
                }
              }}
              placeholder="채팅 검색"
              aria-label="채팅 검색"
              aria-controls="prism-chat-search-results"
              autoComplete="off"
              spellCheck={false}
            />
            <Dialog.Close className="prism-dialog-close" aria-label="검색 닫기"><X size={20} /></Dialog.Close>
          </div>
          <div
            id="prism-chat-search-results"
            className="prism-search-results"
            ref={resultRef}
            aria-busy={pending}
            onKeyDown={(event) => {
              if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
              const buttons = [...(resultRef.current?.querySelectorAll<HTMLButtonElement>('.prism-search-result') || [])];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (index === -1) return;
              event.preventDefault();
              const next = index + (event.key === 'ArrowDown' ? 1 : -1);
              if (next < 0) inputRef.current?.focus();
              else buttons[Math.min(next, buttons.length - 1)]?.focus();
            }}
          >
            {!signedIn ? (
              <div className="prism-search-state">
                <MessageSquare size={26} aria-hidden="true" />
                <p>로그인하면 저장한 대화를 검색할 수 있습니다.</p>
                <a className="prism-action-button primary" href="/signin-with-chatgpt?return_to=%2Fchat" target="_top">ChatGPT로 로그인</a>
              </div>
            ) : error ? (
              <div className="prism-search-state" role="alert">
                <AlertCircle size={24} aria-hidden="true" /><p>{error}</p>
                <button className="prism-action-button" onClick={() => setAttempt((value) => value + 1)}>다시 시도</button>
              </div>
            ) : pending ? (
              <div className="prism-search-state" role="status"><LoaderCircle size={22} className="spin" /><p>검색 중…</p></div>
            ) : results.length ? (
              <>
                <p className="prism-search-label">{query.trim() ? `${results.length}개의 검색 결과` : '최근 대화'}</p>
                {results.map((result) => (
                  <button className="prism-search-result" key={result.id} onClick={() => { close(false); onNavigate(`/chat/${encodeURIComponent(result.id)}`); }}>
                    <MessageSquare size={18} aria-hidden="true" />
                    <span><strong>{result.title}</strong>{result.snippet ? <small>{result.snippet}</small> : <small>{result.model}</small>}</span>
                    <time dateTime={new Date(result.updated_at).toISOString()}>{new Date(result.updated_at).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}</time>
                  </button>
                ))}
              </>
            ) : (
              <div className="prism-search-state" role="status"><Search size={26} aria-hidden="true" /><p>{query.trim() ? '일치하는 대화가 없습니다.' : '검색어를 입력해 대화를 찾아보세요.'}</p></div>
            )}
          </div>
          <div className="prism-search-foot"><span>제목과 메시지 내용 검색</span><span><kbd>↑ ↓</kbd>이동 <kbd>Esc</kbd>닫기</span></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
