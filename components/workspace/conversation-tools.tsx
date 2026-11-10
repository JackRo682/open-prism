'use client';

import { clearDriveTokenResponse, DriveAccessSession, DRIVE_SCOPE, type DriveTokenResponse } from '../../lib/drive-client';

import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { CheckCircle2, Copy, ExternalLink, FileText, LoaderCircle, X } from 'lucide-react';
import { findModel, PROVIDERS, type Provider } from '../../lib/models';
import { gmailComposeUrl } from '../../lib/conversation-export';

export type ExportTarget = { title: string; content: string; kind: 'docs' | 'gmail' };
export type DetailTarget = { id: string; content: string; model?: string; created_at?: number; conversationId?: string };
type ResponseDetails = { model: string | null; provider: string | null; createdAt: number; usage: null | { inputTokens: number; outputTokens: number; durationMs: number; status: string } };
type GoogleToken = DriveTokenResponse;
type GoogleIdentity = { initTokenClient(config: { client_id: string; scope: string; include_granted_scopes: boolean; callback(token: GoogleToken): void; error_callback(error: { type?: string }): void }): { requestAccessToken(options: { prompt: string }): void }; hasGrantedAllScopes(token: GoogleToken, ...scopes: string[]): boolean };
let identityLoad: Promise<void> | null = null;
function identity(): GoogleIdentity | undefined { return (window as Window & { google?: { accounts?: { oauth2?: GoogleIdentity } } }).google?.accounts?.oauth2; }
function loadIdentity() {
  if (identity()) return Promise.resolve();
  if (identityLoad) return identityLoad;
  identityLoad = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(fail, 15000);
    function fail() { clearTimeout(timeout); script.remove(); identityLoad = null; reject(new Error('Google 연결을 불러오지 못했습니다. 다시 시도해 주세요.')); }
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.referrerPolicy = 'strict-origin-when-cross-origin';
    script.onload = () => { clearTimeout(timeout); identity() ? resolve() : fail(); }; script.onerror = fail;
    document.head.appendChild(script);
  });
  return identityLoad;
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('서버 응답을 읽지 못했습니다.');
  if (!response.ok) throw new Error('error' in data && typeof data.error === 'string' ? data.error : '요청을 처리하지 못했습니다. 다시 시도해 주세요.');
  return data as T;
}

export function ExportDialog({ target, onClose, signedIn = true }: { target: ExportTarget | null; onClose(): void; signedIn?: boolean }) {
  const [config, setConfig] = useState<{ configured: boolean; clientId?: string } | null>(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [createdUrl, setCreatedUrl] = useState(''), [uncertain, setUncertain] = useState(false), [copied, setCopied] = useState(false);
  const active = useRef(false), pending = useRef(false), current = useRef(target), operation = useRef('');
  const authorization = useRef<DriveAccessSession | null>(null);
  current.current = target;
  useEffect(() => {
    active.current = !!target; pending.current = false;
    setConfig(null); setReady(false); setBusy(false); setError(''); setCreatedUrl(''); setUncertain(false); setCopied(false);
    operation.current = crypto.randomUUID();
    if (!target || target.kind !== 'docs' || !signedIn) return () => { active.current = false; };
    const controller = new AbortController();
    const discardAuthorization = () => {
      const session = authorization.current; authorization.current = null;
      session?.cancel();
    };
    const hidePage = () => {
      if (authorization.current?.transferInProgress) setUncertain(true);
      discardAuthorization(); pending.current = false; setBusy(false);
    };
    window.addEventListener('pagehide', hidePage);
    fetch('/api/integrations/google-export', { signal: controller.signal, credentials: 'same-origin' }).then(response => jsonResponse<{ configured: boolean; clientId?: string }>(response)).then(async data => {
      if (controller.signal.aborted) return;
      setConfig(data);
      if (data.configured && data.clientId) { await loadIdentity(); if (!controller.signal.aborted) setReady(true); }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Google 연결을 확인하지 못했습니다.'); });
    return () => { active.current = false; controller.abort(); window.removeEventListener('pagehide', hidePage); discardAuthorization(); };
  }, [target, signedIn]);

  async function copyContent() {
    if (!target) return;
    const selected = target, attempt = operation.current;
    const valid = () => active.current && current.current === selected && operation.current === attempt;
    try { await navigator.clipboard.writeText(target.content); if (valid()) setCopied(true); }
    catch { if (valid()) setError('복사하지 못했습니다. 아래 내용을 선택해 직접 복사해 주세요.'); }
  }

  function exportDocs() {
    const oauth = identity(), selected = current.current, attempt = operation.current;
    if (!oauth || !config?.clientId || !selected || pending.current || uncertain || createdUrl) return;
    pending.current = true; setBusy(true); setError('');
    const session = new DriveAccessSession(); authorization.current = session;
    let transferStarted = false;
    const valid = () => active.current && current.current === selected && operation.current === attempt && authorization.current === session;
    const finish = () => {
      if (valid()) { pending.current = false; setBusy(false); authorization.current = null; }
      session.cancel();
    };
    session.signal.addEventListener('abort', () => {
      if (!valid()) return;
      if (transferStarted) setUncertain(true);
      setError(transferStarted ? '생성 결과를 확인하지 못했습니다. 중복 생성을 피하려면 Google Drive에서 문서를 먼저 확인해 주세요.' : 'Google 연결 시간이 초과되었습니다. 다시 연결해 주세요.');
      finish();
    }, { once: true });
    try {
      oauth.initTokenClient({ client_id: config.clientId, scope: DRIVE_SCOPE, include_granted_scopes: false,
        error_callback: failure => { if (valid() && session.awaitingAuthorization) { setError(failure.type === 'popup_closed' ? 'Google 연결을 취소했습니다.' : 'Google 연결 창을 열지 못했습니다. 팝업 설정을 확인해 주세요.'); finish(); } },
        callback: async token => {
          try {
            if (!valid() || !session.awaitingAuthorization) return;
            if (!oauth.hasGrantedAllScopes(token, DRIVE_SCOPE)) throw new Error('문서를 만들려면 Google Drive 연결을 허용해 주세요.');
            if (!session.acceptToken(token)) return;
          } catch (failure) {
            if (valid()) { setError(failure instanceof Error ? failure.message : 'Google 연결을 확인하지 못했습니다.'); finish(); }
            return;
          } finally { clearDriveTokenResponse(token); }
          const boundary = 'prism_' + crypto.randomUUID().replaceAll('-', '');
          const metadata = { name: selected.title.slice(0, 200), mimeType: 'application/vnd.google-apps.document', appProperties: { prism_export_id: attempt } };
          const payload = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) + '\r\n--' + boundary + '\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n' + selected.content + '\r\n--' + boundary + '--';
          let received = false;
          try {
            session.beginTransfer(60000); transferStarted = true;
            const response = await session.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: payload });
            received = response.status >= 400 && response.status < 500;
            if (!response.ok) throw new Error(response.status === 401 ? 'Google 연결이 만료되었습니다. 다시 연결해 주세요.' : response.status === 403 ? 'Google Drive에 문서를 만들 권한이 없습니다.' : '문서 생성 결과를 확인하지 못했습니다.');
            const data = await response.json() as { id?: string };
            if (!data.id || !/^[A-Za-z0-9_-]+$/.test(data.id)) throw new Error('문서 생성 결과를 확인하지 못했습니다.');
            if (valid()) setCreatedUrl('https://docs.google.com/document/d/' + data.id + '/edit');
          } catch (failure) {
            if (valid()) { setUncertain(!received); setError(!received ? '생성 결과를 확인하지 못했습니다. 중복 생성을 피하려면 Google Drive에서 문서를 먼저 확인해 주세요.' : failure instanceof Error ? failure.message : '문서를 만들지 못했습니다.'); }
          } finally { finish(); }
        },
      }).requestAccessToken({ prompt: 'select_account' });
    } catch { setError('Google 연결을 시작하지 못했습니다.'); finish(); }
  }
  const gmailUrl = target?.kind === 'gmail' ? gmailComposeUrl(target.title, target.content) : '';
  const longDraft = gmailUrl.length > 7000;
  return <Dialog.Root open={!!target} onOpenChange={open => { if (!open && !busy) onClose(); }}><Dialog.Portal><Dialog.Overlay className="prism-dialog-overlay"/><Dialog.Content className="prism-dialog-content prism-export-dialog" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
    <div className="prism-dialog-heading"><Dialog.Title>{target?.kind === 'gmail' ? 'Gmail 초안 작성' : 'Docs로 내보내기'}</Dialog.Title><Dialog.Close className="prism-icon" aria-label="닫기" disabled={busy}><X size={20}/></Dialog.Close></div>
    <Dialog.Description>{target?.kind === 'gmail' ? '선택한 응답으로 Gmail 작성창을 엽니다. 수신자와 내용을 확인한 뒤 직접 전송하세요.' : '선택한 내용을 Google 문서로 내보냅니다.'}</Dialog.Description>
    {target?.kind === 'docs' && !config && signedIn && !error && <p className="prism-tool-progress"><LoaderCircle size={18} className="spin"/>Google 연결 확인 중…</p>}
    {target?.kind === 'docs' && ((!signedIn || config?.configured === false) && <p className="prism-export-note">Google 문서 자동 연결이 아직 준비되지 않았습니다. 내용을 복사한 뒤 새 Google 문서에 붙여넣을 수 있습니다.</p>)}
    {target?.kind === 'gmail' && longDraft && <p className="prism-export-note">응답이 길어 전체 내용을 먼저 복사한 뒤 Gmail 작성창에 붙여넣어 주세요.</p>}
    <label className="prism-export-preview">내용<textarea readOnly rows={6} value={target?.content || ''}/></label>
    {error && <p role="alert" className="prism-form-error">{error}</p>}
    {createdUrl ? <p className="prism-export-success" role="status"><CheckCircle2 size={18}/>새 문서가 생성되었습니다. <a href={createdUrl} target="_blank" rel="noopener noreferrer">Docs 열기<ExternalLink size={15}/></a></p> : <div className="prism-dialog-actions">
      <button type="button" className="prism-secondary-button" onClick={() => void copyContent()} disabled={busy}><Copy size={16}/>{copied ? '복사됨' : '내용 복사'}</button>
      {target?.kind === 'gmail' ? <a className="prism-primary-button" href={longDraft ? 'https://mail.google.com/mail/?view=cm&fs=1' : gmailUrl} target="_blank" rel="noopener noreferrer">Gmail 열기<ExternalLink size={16}/></a>
        : uncertain ? <a className="prism-primary-button" href="https://drive.google.com/drive/recent" target="_blank" rel="noopener noreferrer">Drive에서 확인<ExternalLink size={16}/></a>
          : config?.configured ? <button type="button" className="prism-primary-button" disabled={!ready || busy} onClick={exportDocs}>{busy ? <LoaderCircle size={16} className="spin"/> : <FileText size={16}/>}Google 연결 후 내보내기</button>
            : <a className="prism-primary-button" href="https://docs.google.com/document/create" target="_blank" rel="noopener noreferrer">새 Google 문서 열기<ExternalLink size={16}/></a>}
    </div>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function ResponseDetailsDialog({ target, onClose }: { target: DetailTarget | null; onClose(): void }) {
  const [details, setDetails] = useState<ResponseDetails | null>(null), [error, setError] = useState('');
  useEffect(() => {
    setDetails(null); setError('');
    if (!target?.conversationId) return;
    const controller = new AbortController();
    fetch('/api/conversations/' + encodeURIComponent(target.conversationId) + '/messages/' + encodeURIComponent(target.id) + '/details', { signal: controller.signal }).then(response => jsonResponse<ResponseDetails>(response)).then(data => { if (!controller.signal.aborted) setDetails(data); }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '응답 정보를 불러오지 못했습니다.'); });
    return () => controller.abort();
  }, [target]);
  const model = findModel(details?.model || target?.model || ''), timestamp = details?.createdAt || target?.created_at;
  return <Dialog.Root open={!!target} onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal><Dialog.Overlay className="prism-details-overlay"/><Dialog.Content className="prism-response-details">
    <div className="prism-dialog-heading"><Dialog.Title>대답 세부정보</Dialog.Title><Dialog.Close className="prism-icon" aria-label="세부정보 닫기"><X size={20}/></Dialog.Close></div><Dialog.Description className="sr-only">이 응답의 모델과 생성 정보</Dialog.Description>
    {model || details?.model || target?.model ? <p className="prism-details-model"><CheckCircle2 size={20}/>{model?.name || details?.model || target?.model} 사용함</p> : <p className="prism-export-note">저장된 모델 정보가 없습니다.</p>}
    {model && <dl><dt>제공사</dt><dd>{PROVIDERS[model.provider as Provider].name}</dd></dl>}
    {!!timestamp && <dl><dt>생성 시각</dt><dd>{new Date(timestamp).toLocaleString('ko-KR')}</dd></dl>}
    {details?.usage && <dl><dt>생성 시간</dt><dd>{(details.usage.durationMs / 1000).toFixed(1)}초</dd><dt>입력 토큰</dt><dd>{details.usage.inputTokens.toLocaleString()}</dd><dt>출력 토큰</dt><dd>{details.usage.outputTokens.toLocaleString()}</dd></dl>}
    {target?.conversationId && !details && !error && <p role="status">응답 정보 불러오는 중…</p>}
    {error && <p className="prism-form-error" role="alert">{error}</p>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function LegalReportDialog({ target, onClose, signedIn = true }: { target: DetailTarget | null; onClose(): void; signedIn?: boolean }) {
  const [category, setCategory] = useState('legal'), [details, setDetails] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState('');
  const requestId = useRef(''), pending = useRef(false), active = useRef(false), current = useRef(target);
  current.current = target;
  useEffect(() => { active.current = !!target; setCategory('legal'); setDetails(''); setError(''); setReceipt(''); setBusy(false); pending.current = false; requestId.current = crypto.randomUUID(); return () => { active.current = false; }; }, [target]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!target?.conversationId || pending.current || details.trim().length < 10) return;
    pending.current = true; setBusy(true); setError('');
    const selected = target, attempt = requestId.current;
    const valid = () => active.current && current.current === selected && requestId.current === attempt;
    try {
      const data = await fetch('/api/conversations/' + encodeURIComponent(target.conversationId) + '/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: target.id, category, details: details.trim(), requestId: attempt }) }).then(response => jsonResponse<{ id: string }>(response));
      if (valid()) setReceipt(data.id);
    } catch (failure) { if (valid()) setError(failure instanceof Error ? failure.message : '신고를 접수하지 못했습니다.'); }
    finally { if (valid()) { pending.current = false; setBusy(false); } }
  }
  return <Dialog.Root open={!!target} onOpenChange={open => { if (!open && !busy) onClose(); }}><Dialog.Portal><Dialog.Overlay className="prism-dialog-overlay"/><Dialog.Content className="prism-dialog-content prism-report-dialog" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
    <form onSubmit={submit}><div className="prism-dialog-heading"><Dialog.Title>법적 문제 신고</Dialog.Title><Dialog.Close className="prism-icon" aria-label="닫기" disabled={busy}><X size={20}/></Dialog.Close></div><Dialog.Description>신고 사유와 해당 응답이 Prism에 기록됩니다.</Dialog.Description>
      {!signedIn || !target?.conversationId ? <p>대화를 저장한 뒤 신고할 수 있습니다. 로그인하면 현재 대화를 가져올 수 있습니다.</p> : receipt ? <div role="status"><p>신고가 접수되었습니다.</p><p className="prism-report-receipt">접수 번호: {receipt}</p></div> : <>
        <label>신고 유형<select value={category} disabled={busy} onChange={event => setCategory(event.target.value)}><option value="legal">법적 문제</option><option value="copyright">저작권 침해</option><option value="privacy">개인정보 침해</option><option value="illegal">불법 콘텐츠</option><option value="other">기타</option></select></label>
        <label>상세 설명<textarea required minLength={10} maxLength={5000} rows={5} disabled={busy} value={details} onChange={event => setDetails(event.target.value)} placeholder="문제와 관련된 내용을 10자 이상 입력해 주세요."/></label>
        {error && <p role="alert" className="prism-form-error">{error}</p>}
        <div className="prism-dialog-actions"><Dialog.Close className="prism-secondary-button" disabled={busy}>취소</Dialog.Close><button type="submit" className="prism-primary-button" disabled={busy || details.trim().length < 10}>{busy && <LoaderCircle size={16} className="spin"/>}신고 제출</button></div>
      </>}
    </form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
