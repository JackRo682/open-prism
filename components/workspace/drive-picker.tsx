'use client';

import { clearDriveTokenResponse, DriveAccessSession, DRIVE_SCOPE, DRIVE_SELECTABLE_MIME_TYPES, selectedDriveFile, type DriveTokenResponse } from '../../lib/drive-client';

import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { AlertCircle, ArrowRight, Cloud, LoaderCircle, X } from 'lucide-react';

type DriveConfiguration = { configured: boolean; clientId?: string; developerKey?: string; appId?: string };
type TokenResponse = DriveTokenResponse;
type PickerInstance = { setVisible(visible: boolean): void; dispose?(): void };
type PickerView = { setMimeTypes(types: string): PickerView; setMode(mode: string): PickerView; setIncludeFolders(include: boolean): PickerView; setSelectFolderEnabled(enabled: boolean): PickerView };
type PickerBuilder = {
  addView(view: PickerView): PickerBuilder; setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder; setAppId(id: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder; setLocale(locale: string): PickerBuilder;
  setSize(width: number, height: number): PickerBuilder;
  setCallback(callback: (data: { action?: string; docs?: Array<{ id?: string }> }) => void): PickerBuilder;
  build(): PickerInstance;
};
type GoogleWindow = Window & {
  gapi?: { load(name: string, options: { callback(): void; onerror(): void; timeout: number; ontimeout(): void }): void };
  google?: {
    accounts?: { oauth2: {
      initTokenClient(config: { client_id: string; scope: string; include_granted_scopes: boolean; callback(response: TokenResponse): void; error_callback(error: { type?: string }): void }): { requestAccessToken(options: { prompt: string }): void };
      hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean;
    } };
    picker?: { PickerBuilder: new () => PickerBuilder; DocsView: new (view: string) => PickerView; ViewId: { DOCS: string }; DocsViewMode: { LIST: string }; Action: { PICKED: string; CANCEL: string } };
  };
};

const scriptLoads = new Map<string, Promise<void>>();

/** Called only after the user opens the Drive picker. */
function loadGoogleScript(src: string): Promise<void> {
  const existing = scriptLoads.get(src);
  if (existing) return existing;
  const task = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src; script.async = true; script.defer = true;
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    const timeout = window.setTimeout(() => fail(), 15000);
    function clean() { window.clearTimeout(timeout); script.onload = null; script.onerror = null; }
    function fail() { clean(); script.remove(); scriptLoads.delete(src); reject(new Error('Google 연결 도구를 불러오지 못했습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.')); }
    script.onload = () => { clean(); resolve(); };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  scriptLoads.set(src, task);
  return task;
}

async function prepareGooglePicker() {
  const browser = window as GoogleWindow;
  await Promise.all([
    browser.gapi ? Promise.resolve() : loadGoogleScript('https://apis.google.com/js/api.js'),
    browser.google?.accounts?.oauth2 ? Promise.resolve() : loadGoogleScript('https://accounts.google.com/gsi/client'),
  ]);
  if (!browser.google?.picker) await new Promise<void>((resolve, reject) => {
    if (!browser.gapi) { reject(new Error('Google 파일 선택기를 불러오지 못했습니다.')); return; }
    browser.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Google 파일 선택기를 불러오지 못했습니다.')), timeout: 15000, ontimeout: () => reject(new Error('Google 파일 선택기 연결 시간이 초과되었습니다.')) });
  });
  if (!browser.google?.picker || !browser.google?.accounts?.oauth2) throw new Error('Google 연결 도구를 준비하지 못했습니다.');
}

export function DrivePickerDialog({ open, onOpenChange, signedIn, onFile, onNavigate }: {
  open: boolean; onOpenChange(open: boolean): void; signedIn: boolean;
  onFile(file: File): Promise<void>; onNavigate(path: string): void;
}) {
  const [config, setConfig] = useState<DriveConfiguration | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mountedOpen = useRef(false);
  const pickerActive = useRef(false);
  const picker = useRef<PickerInstance | null>(null);
  const selection = useRef<DriveAccessSession | null>(null);
  const upload = useRef(onFile); upload.current = onFile;
  const changeOpen = useRef(onOpenChange); changeOpen.current = onOpenChange;

  useEffect(() => {
    mountedOpen.current = open && signedIn;
    if (!open || !signedIn) return;
    const controller = new AbortController();
    const discardSelection = () => {
      const session = selection.current; selection.current = null; session?.cancel();
      disposePicker();
      setPickerOpen(false); setBusy(false);
    };
    window.addEventListener('pagehide', discardSelection);
    setReady(false); setError(''); setConfig(null);
    fetch('/api/integrations/drive', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        const data = await response.json() as DriveConfiguration & { error?: string };
        if (!response.ok) throw new Error(data.error || 'Drive 연결 설정을 불러오지 못했습니다.');
        if (controller.signal.aborted) return;
        setConfig(data);
        if (!data.configured) return;
        if (!data.clientId || !data.developerKey || !data.appId || !/^\d+$/.test(data.appId)) throw new Error('Drive 연결 설정을 확인해 주세요.');
        await prepareGooglePicker();
        if (!controller.signal.aborted) setReady(true);
      }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Drive 연결을 준비하지 못했습니다.'); });
    return () => {
      mountedOpen.current = false;
      controller.abort();
      window.removeEventListener('pagehide', discardSelection);
      discardSelection();
    };
  }, [open, signedIn, attempt]);

  function isCurrent(session: DriveAccessSession) { return mountedOpen.current && selection.current === session; }

  function disposePicker() {
    const instance = picker.current; picker.current = null; pickerActive.current = false;
    // Drop the reference before disposal: SDK callbacks may be re-entrant.
    try { instance?.setVisible(false); } catch { /* Continue clearing the picker. */ }
    try { instance?.dispose?.(); } catch { /* Continue clearing the session. */ }
  }

  function finishSelection(session: DriveAccessSession) {
    if (selection.current !== session) { session.cancel(); return; }
    selection.current = null; session.cancel(); disposePicker();
    if (mountedOpen.current) { setPickerOpen(false); setBusy(false); }
  }

  async function pickFile(id: string, session: DriveAccessSession) {
    setBusy(true); setError('');
    try {
      const file = await selectedDriveFile(id, session);
      if (session.signal.aborted || !isCurrent(session)) return;
      // selectedDriveFile has already discarded the Google token here.
      await upload.current(file);
      if (!session.signal.aborted && isCurrent(session)) changeOpen.current(false);
    } catch (cause) {
      if (!session.signal.aborted && isCurrent(session)) setError(cause instanceof Error ? cause.message : 'Drive 파일을 첨부하지 못했습니다.');
    } finally { finishSelection(session); }
  }

  function showPicker(session: DriveAccessSession) {
    const api = (window as GoogleWindow).google?.picker;
    if (!isCurrent(session)) { session.cancel(); return; }
    if (!api || !config?.developerKey || !config.appId) { finishSelection(session); setError('Google 파일 선택기를 준비하지 못했습니다. 다시 연결해 주세요.'); return; }
    try {
    const view = new api.DocsView(api.ViewId.DOCS).setMimeTypes(DRIVE_SELECTABLE_MIME_TYPES.join(','))
      .setMode(api.DocsViewMode.LIST).setIncludeFolders(true).setSelectFolderEnabled(false);
    let settled = false;
    let instance: PickerInstance | null = null;
    instance = new api.PickerBuilder().addView(view).setOAuthToken(session.tokenForPicker())
      .setDeveloperKey(config.developerKey).setAppId(config.appId).setOrigin(window.location.origin).setLocale('ko')
      .setSize(Math.max(280, Math.min(1000, window.innerWidth - 24)), Math.max(240, Math.min(700, window.innerHeight - 32)))
      .setCallback(data => {
        if (settled || !instance || !isCurrent(session) || picker.current !== instance || (data.action !== api.Action.PICKED && data.action !== api.Action.CANCEL)) return;
        settled = true; disposePicker(); setPickerOpen(false);
        if (data.action === api.Action.PICKED && data.docs?.[0]?.id) void pickFile(data.docs[0].id, session);
        else finishSelection(session);
      }).build();
    picker.current = instance; pickerActive.current = true; setPickerOpen(true); setBusy(false);
    instance.setVisible(true);
    } catch {
      finishSelection(session);
      setError('Google 파일 선택기를 열지 못했습니다. 연결 설정을 확인하고 다시 시도해 주세요.');
    }
  }

  function connect() {
    if (!ready || busy || !mountedOpen.current || selection.current || !config?.clientId) return;
    const oauth = (window as GoogleWindow).google?.accounts?.oauth2;
    if (!oauth) return;
    setError('');
    const session = new DriveAccessSession(); selection.current = session;
    session.signal.addEventListener('abort', () => {
      if (!isCurrent(session)) return;
      const reason = session.signal.reason;
      finishSelection(session);
      if (reason instanceof Error && reason.name === 'TimeoutError') setError(reason.message);
    }, { once: true });
    setBusy(true);
    try {
    const client = oauth.initTokenClient({
      client_id: config.clientId, scope: DRIVE_SCOPE, include_granted_scopes: false,
      callback: response => {
        try {
          if (!isCurrent(session) || !session.awaitingAuthorization) return;
          if (!oauth.hasGrantedAllScopes(response, DRIVE_SCOPE)) throw new Error('Drive에서 선택한 파일을 읽으려면 Google 계정의 파일 접근 동의가 필요합니다.');
          if (session.acceptToken(response)) showPicker(session);
        } catch (cause) {
          if (isCurrent(session)) { finishSelection(session); setError(cause instanceof Error ? cause.message : 'Google 연결을 확인하지 못했습니다.'); }
        } finally {
          clearDriveTokenResponse(response);
        }
      },
      error_callback: cause => { if (isCurrent(session) && session.awaitingAuthorization) { finishSelection(session); setError(cause.type === 'popup_closed' ? 'Google 연결 창을 닫았습니다. 다시 연결할 수 있습니다.' : 'Google 연결 창을 열지 못했습니다. 이 사이트의 팝업을 허용하고 다시 시도해 주세요.'); } },
    });
    client.requestAccessToken({ prompt: 'consent' });
    } catch {
      finishSelection(session); setError('Google 연결 창을 열지 못했습니다. 연결 설정과 팝업 권한을 확인해 주세요.');
    }
  }

  return <Dialog.Root open={open && !pickerOpen} onOpenChange={next => { if (!pickerActive.current) onOpenChange(next); }}>
    <Dialog.Portal><Dialog.Overlay className="prism-dialog-overlay" /><Dialog.Content className="prism-dialog-content prism-drive-dialog" onCloseAutoFocus={event => { if (pickerActive.current) event.preventDefault(); }}>
      <div className="prism-dialog-heading"><Dialog.Title><Cloud size={23} aria-hidden="true" />Google Drive</Dialog.Title><Dialog.Close className="prism-icon" aria-label="Drive 연결 닫기"><X size={19} /></Dialog.Close></div>
      <Dialog.Description>Google Drive에서 직접 선택한 문서를 Prism에 첨부합니다.</Dialog.Description>
      {!signedIn ? <><p>문서를 내 계정에 저장하려면 먼저 로그인해 주세요.</p><a className="prism-action-button primary" data-prism-auth-link="true" href="/signin-with-chatgpt?return_to=%2Fchat">ChatGPT로 로그인<ArrowRight size={16} /></a></>
        : config?.configured === false ? <div className="prism-integration-card"><h2>Drive 연결 설정이 필요합니다</h2><p>연결이 완료되면 Google 계정에서 문서를 선택할 수 있습니다.</p><button type="button" className="prism-action-button" onClick={() => { onOpenChange(false); onNavigate('/settings'); }}>AI 연결 상태 확인<ArrowRight size={16} /></button></div>
        : <><p>Google 문서·프레젠테이션은 텍스트로, 스프레드시트는 첫 번째 시트의 CSV로 가져옵니다. 첨부 한도는 128KB입니다.</p><p className="prism-drive-privacy">Google 접근 토큰은 이 화면에서만 사용하며 Prism 서버에 저장하지 않습니다. 선택한 문서의 내용은 첨부 파일로 저장됩니다.</p><button type="button" className="prism-action-button primary" disabled={!ready || busy} onClick={connect}>{!ready || busy ? <LoaderCircle size={17} className="spin" /> : <Cloud size={18} />}{busy ? 'Google 연결 또는 파일을 가져오는 중…' : ready ? 'Google 계정 연결 · 파일 선택' : 'Google 연결 도구 준비 중…'}</button></>}
      {error && <div className="prism-integration-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><span>{error}</span></div>}
      {signedIn && error && !ready && <button type="button" className="prism-action-button" onClick={() => setAttempt(value => value + 1)}>다시 시도</button>}
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
