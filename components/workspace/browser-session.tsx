'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowRight, FileText, Globe2, History, Image, LoaderCircle, Square } from 'lucide-react';
import type { BrowserCapture } from '../../lib/browser-workspace';

type SessionSummary = Pick<BrowserCapture, 'id'|'url'|'title'|'created_at'>;

async function browserRequest<T>(path = '', options?: RequestInit): Promise<T> {
  const response = await fetch('/api/browser/sessions' + path, { credentials: 'same-origin', ...options });
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('원격 브라우저 응답을 읽지 못했습니다.');
  if (!response.ok) throw new Error('error' in data && typeof data.error === 'string' ? data.error : '원격 브라우저 응답을 불러오지 못했습니다.');
  return data as T;
}

export function BrowserSessionPage({ signedIn, remoteConfigured = false, initialUrl = '', onNavigate }: {
  signedIn: boolean; remoteConfigured?: boolean; initialUrl?: string; onNavigate(path: string): void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [configured, setConfigured] = useState(remoteConfigured);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [current, setCurrent] = useState<BrowserCapture | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'preview'|'text'>('preview');
  const abort = useRef<AbortController | null>(null);
  const addressInput = useRef<HTMLInputElement>(null);

  useEffect(() => { setConfigured(remoteConfigured); }, [remoteConfigured]);
  useEffect(() => {
    const fromLink = initialUrl || new URLSearchParams(window.location.search).get('url') || '';
    if (fromLink) { setUrl(fromLink); addressInput.current?.focus(); }
  }, [initialUrl]);
  useEffect(() => {
    if (!signedIn) { setSessions([]); setCurrent(null); return; }
    const controller = new AbortController();
    setLoadingHistory(true); setError('');
    browserRequest<{ sessions?: SessionSummary[]; configured?: boolean }>('', { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) {
        setSessions(Array.isArray(data.sessions) ? data.sessions : []);
        if (typeof data.configured === 'boolean') setConfigured(data.configured);
      }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '원격 페이지 기록을 불러오지 못했습니다.'); })
      .finally(() => { if (!controller.signal.aborted) setLoadingHistory(false); });
    return () => { controller.abort(); abort.current?.abort(); };
  }, [signedIn]);

  async function browse(address: string) {
    if (!signedIn || busy) return;
    if (!configured) { setError('원격 브라우저 연결이 필요합니다. 현재 브라우저에서 주소를 열지 않았습니다.'); return; }
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setError('');
    try {
      const capture = await browserRequest<BrowserCapture>('', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: address }), signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setCurrent(capture); setUrl(capture.url); setTab(capture.screenshot ? 'preview' : 'text');
      setSessions(list => [{ id: capture.id, url: capture.url, title: capture.title, created_at: capture.created_at }, ...list.filter(item => item.id !== capture.id)].slice(0, 100));
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '원격 페이지를 열지 못했습니다.');
    } finally { if (abort.current === controller) { abort.current = null; setBusy(false); } }
  }

  async function openSaved(id: string) {
    if (busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setError('');
    try {
      const capture = await browserRequest<BrowserCapture>('/' + encodeURIComponent(id), { signal: controller.signal });
      if (controller.signal.aborted) return;
      setCurrent(capture); setUrl(capture.url); setTab(capture.screenshot ? 'preview' : 'text');
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '저장된 페이지를 불러오지 못했습니다.'); }
    finally { if (abort.current === controller) { abort.current = null; setBusy(false); } }
  }

  function submit(event: FormEvent) { event.preventDefault(); void browse(url); }

  return <section className="prism-integration-page prism-remote-browser" aria-labelledby="prism-remote-title">
    <header><span className="prism-integration-eyebrow"><Globe2 size={18} aria-hidden="true" />원격 작업 공간</span><h1 id="prism-remote-title">브라우저</h1><p>격리된 원격 브라우저에서 공개 페이지를 읽고 화면과 본문을 보관합니다.</p></header>
    {!signedIn ? <div className="prism-integration-card"><h2>로그인하고 원격 페이지를 보관하세요</h2><p>원격 페이지와 미리보기는 내 계정에 저장됩니다.</p><a className="prism-action-button primary" data-prism-auth-link="true" href={'/signin-with-chatgpt?return_to=' + encodeURIComponent('/browser' + (url ? '?url=' + encodeURIComponent(url) : ''))}>ChatGPT로 로그인<ArrowRight size={16} /></a></div> : <>
      {!configured && <div className="prism-integration-card"><h2>원격 브라우저 연결이 필요합니다</h2><p>주소는 그대로 보관되어 있습니다. 서비스가 연결되기 전에는 외부 페이지를 열지 않습니다.</p><button type="button" className="prism-action-button" onClick={() => onNavigate('/settings')}>AI 연결 상태 확인<ArrowRight size={16} /></button></div>}
      <form className="prism-browser-address" onSubmit={submit}>
        <label htmlFor="prism-browser-address">웹페이지 주소</label>
        <div><Globe2 size={19} aria-hidden="true" /><input id="prism-browser-address" ref={addressInput} value={url} onChange={event => setUrl(event.target.value)} type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://example.com" maxLength={4096} disabled={busy} required />
          {busy ? <button type="button" aria-label="원격 페이지 요청 중지" onClick={() => abort.current?.abort()}><Square size={17} aria-hidden="true" /></button> : <button type="submit" disabled={!configured || !url.trim()} aria-label="원격으로 페이지 열기"><ArrowRight size={21} aria-hidden="true" /></button>}
        </div>
        <small>하루 최대 5회 · 로그인된 페이지나 입력·결제 작업은 지원하지 않습니다.</small>
      </form>
      {busy && <p className="prism-integration-status" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" />페이지를 불러오고 있습니다…</p>}
      {error && <p className="prism-integration-error" role="alert"><AlertCircle size={18} aria-hidden="true" />{error}</p>}
      <div className="prism-browser-layout">
        <div className="prism-browser-capture">
          {current ? <>
            <header><h2>{current.title}</h2><p>{current.url}</p><small>{new Date(current.created_at).toLocaleString('ko-KR')}에 저장</small></header>
            <div className="prism-browser-tabs" role="tablist" aria-label="원격 페이지 보기">
              <button type="button" role="tab" aria-selected={tab === 'preview'} aria-controls="prism-browser-capture-preview" id="prism-browser-preview-tab" disabled={!current.screenshot} onClick={() => setTab('preview')}><Image size={17} />미리보기</button>
              <button type="button" role="tab" aria-selected={tab === 'text'} aria-controls="prism-browser-capture-text" id="prism-browser-text-tab" onClick={() => setTab('text')}><FileText size={17} />본문</button>
            </div>
            {tab === 'preview' && current.screenshot && <div role="tabpanel" id="prism-browser-capture-preview" aria-labelledby="prism-browser-preview-tab" tabIndex={0}><img src={current.screenshot} className="prism-browser-screenshot" alt={`${current.title} 원격 브라우저 화면`} /></div>}
            {tab === 'text' && <div role="tabpanel" id="prism-browser-capture-text" aria-labelledby="prism-browser-text-tab" tabIndex={0} className="prism-browser-text">{current.text || '이 페이지에서 읽을 수 있는 본문을 찾지 못했습니다.'}</div>}
            {current.links.length > 0 && <section className="prism-browser-links"><h3>페이지의 링크</h3>{current.links.map(link => <button type="button" key={link.url} disabled={busy} onClick={() => { void browse(link.url); }}><span>{link.title || link.url}</span><ArrowRight size={15} aria-hidden="true" /></button>)}</section>}
          </> : <div className="prism-browser-empty"><Globe2 size={32} aria-hidden="true" /><h2>열어 볼 페이지를 입력하세요</h2><p>실제 원격 브라우저에서 읽은 페이지와 미리보기가 여기에 표시됩니다.</p></div>}
        </div>
        <aside className="prism-browser-history"><h2><History size={17} aria-hidden="true" />저장된 페이지</h2>{loadingHistory ? <p role="status">기록을 불러오는 중…</p> : sessions.length ? sessions.map(session => <button type="button" disabled={busy} key={session.id} aria-pressed={session.id === current?.id} onClick={() => { void openSaved(session.id); }}><strong>{session.title}</strong><small>{new URL(session.url).hostname}</small></button>) : <p>아직 저장된 페이지가 없습니다.</p>}<button type="button" className="prism-browser-history-settings" onClick={() => onNavigate('/browser-settings')}>브라우저 설정 · 기록 삭제</button></aside>
      </div>
    </>}
  </section>;
}
