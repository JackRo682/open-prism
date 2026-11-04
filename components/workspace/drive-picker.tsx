'use client';

import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { AlertCircle, ArrowRight, Cloud, LoaderCircle, X } from 'lucide-react';

type DriveConfiguration = { configured: boolean; clientId?: string; developerKey?: string; appId?: string };
type TokenResponse = { access_token?: string; expires_in?: number; error?: string; scope?: string };
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

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const MAX_FILE_BYTES = 131072;
const googleExports: Record<string, { mime: string; extension: string }> = {
  'application/vnd.google-apps.document': { mime: 'text/plain', extension: 'txt' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', extension: 'csv' },
  'application/vnd.google-apps.presentation': { mime: 'text/plain', extension: 'txt' },
};
const selectableMimeTypes = [
  ...Object.keys(googleExports), 'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css',
  'text/javascript', 'text/xml', 'application/json', 'application/xml', 'application/javascript',
];
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

async function selectedDriveFile(id: string, token: string, signal: AbortSignal): Promise<File> {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new Error('선택한 Drive 파일을 확인할 수 없습니다.');
  const endpoint = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id);
  const headers = { Authorization: 'Bearer ' + token };
  const metadata = await fetch(endpoint + '?fields=id,name,mimeType,size,capabilities(canDownload)&supportsAllDrives=true', { headers, signal, credentials: 'omit', cache: 'no-store' });
  if (!metadata.ok) throw new Error(metadata.status === 401 ? 'Google 연결이 만료되었습니다. 다시 연결해 주세요.' : '선택한 파일을 읽을 권한이 없습니다. Google Drive 공유 설정을 확인해 주세요.');
  const file = await metadata.json() as { id?: string; name?: string; mimeType?: string; size?: string; capabilities?: { canDownload?: boolean } };
  if (file.capabilities?.canDownload !== true) throw new Error('소유자가 다운로드를 허용하지 않은 파일입니다.');
  if (typeof file.name !== 'string' || typeof file.mimeType !== 'string') throw new Error('Drive 파일 정보를 읽지 못했습니다.');
  const exportType = googleExports[file.mimeType];
  if (!exportType && !selectableMimeTypes.includes(file.mimeType)) throw new Error('Google 문서, 스프레드시트, 프레젠테이션 또는 텍스트 파일을 선택해 주세요.');
  if (!exportType && Number(file.size || 0) > MAX_FILE_BYTES) throw new Error('첨부 파일은 128KB 이하여야 합니다.');
  const downloadUrl = exportType ? endpoint + '/export?mimeType=' + encodeURIComponent(exportType.mime) : endpoint + '?alt=media';
  const response = await fetch(downloadUrl, { headers, signal, credentials: 'omit', cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error('선택한 파일을 가져오지 못했습니다. 다운로드 권한과 Google 연결을 확인해 주세요.');
  if (Number(response.headers.get('Content-Length') || 0) > MAX_FILE_BYTES) { await response.body.cancel(); throw new Error('내보낸 문서가 128KB를 넘습니다. 문서를 나누어 첨부해 주세요.'); }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) { await reader.cancel(); throw new Error('내보낸 문서가 128KB를 넘습니다. 문서를 나누어 첨부해 주세요.'); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  if (text.includes('\0')) throw new Error('텍스트로 읽을 수 있는 파일을 선택해 주세요.');
  const baseName = file.name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 130) || 'Drive 문서';
  const name = exportType ? baseName + '.' + exportType.extension
    : /\.(txt|md|csv|json|ts|tsx|js|jsx|py|html|css|xml|yaml|yml|sql)$/i.test(baseName) ? baseName : baseName + '.txt';
  return new File([text], name, { type: exportType?.mime || 'text/plain', lastModified: Date.now() });
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
  const token = useRef<{ value: string; expiresAt: number } | null>(null);
  const transfer = useRef<AbortController | null>(null);
  const upload = useRef(onFile); upload.current = onFile;
  const changeOpen = useRef(onOpenChange); changeOpen.current = onOpenChange;

  useEffect(() => {
    mountedOpen.current = open;
    if (!open || !signedIn) return;
    const controller = new AbortController();
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
      controller.abort(); transfer.current?.abort();
      token.current = null;
      picker.current?.setVisible(false); picker.current?.dispose?.(); picker.current = null;
      pickerActive.current = false;
      setPickerOpen(false); setBusy(false);
    };
  }, [open, signedIn, attempt]);

  async function pickFile(id: string, accessToken: string) {
    const controller = new AbortController(); transfer.current = controller;
    setBusy(true); setError('');
    try {
      const file = await selectedDriveFile(id, accessToken, controller.signal);
      if (controller.signal.aborted || !mountedOpen.current) return;
      await upload.current(file);
      if (!controller.signal.aborted && mountedOpen.current) changeOpen.current(false);
    } catch (cause) {
      token.current = null;
      if (!controller.signal.aborted && mountedOpen.current) setError(cause instanceof Error ? cause.message : 'Drive 파일을 첨부하지 못했습니다.');
    } finally { if (!controller.signal.aborted && mountedOpen.current) setBusy(false); }
  }

  function showPicker(accessToken: string) {
    const api = (window as GoogleWindow).google?.picker;
    if (!mountedOpen.current) return;
    if (!api || !config?.developerKey || !config.appId) { setBusy(false); setError('Google 파일 선택기를 준비하지 못했습니다. 다시 연결해 주세요.'); return; }
    try {
    const view = new api.DocsView(api.ViewId.DOCS).setMimeTypes(selectableMimeTypes.join(','))
      .setMode(api.DocsViewMode.LIST).setIncludeFolders(true).setSelectFolderEnabled(false);
    const instance = new api.PickerBuilder().addView(view).setOAuthToken(accessToken)
      .setDeveloperKey(config.developerKey).setAppId(config.appId).setOrigin(window.location.origin).setLocale('ko')
      .setSize(Math.max(280, Math.min(1000, window.innerWidth - 24)), Math.max(240, Math.min(700, window.innerHeight - 32)))
      .setCallback(data => {
        if (data.action !== api.Action.PICKED && data.action !== api.Action.CANCEL) return;
        picker.current?.setVisible(false); picker.current?.dispose?.(); picker.current = null;
        pickerActive.current = false; setPickerOpen(false); setBusy(false);
        if (data.action === api.Action.PICKED && data.docs?.[0]?.id) void pickFile(data.docs[0].id, accessToken);
      }).build();
    picker.current = instance; pickerActive.current = true; setPickerOpen(true); setBusy(false);
    instance.setVisible(true);
    } catch {
      picker.current = null; pickerActive.current = false; setPickerOpen(false); setBusy(false);
      setError('Google 파일 선택기를 열지 못했습니다. 연결 설정을 확인하고 다시 시도해 주세요.');
    }
  }

  function connect() {
    if (!ready || busy || !config?.clientId) return;
    const oauth = (window as GoogleWindow).google?.accounts?.oauth2;
    if (!oauth) return;
    setError('');
    if (token.current && token.current.expiresAt > Date.now()) { showPicker(token.current.value); return; }
    setBusy(true);
    try {
    const client = oauth.initTokenClient({
      client_id: config.clientId, scope: DRIVE_SCOPE, include_granted_scopes: false,
      callback: response => {
        if (!mountedOpen.current) return;
        if (response.error || !response.access_token || !oauth.hasGrantedAllScopes(response, DRIVE_SCOPE)) {
          setBusy(false); setError('Drive에서 선택한 파일을 읽으려면 Google 계정의 파일 접근 동의가 필요합니다.'); return;
        }
        token.current = { value: response.access_token, expiresAt: Date.now() + Math.max(0, (Number(response.expires_in) || 300) - 30) * 1000 };
        showPicker(response.access_token);
      },
      error_callback: cause => { if (mountedOpen.current) { setBusy(false); setError(cause.type === 'popup_closed' ? 'Google 연결 창을 닫았습니다. 다시 연결할 수 있습니다.' : 'Google 연결 창을 열지 못했습니다. 이 사이트의 팝업을 허용하고 다시 시도해 주세요.'); } },
    });
    client.requestAccessToken({ prompt: 'consent' });
    } catch {
      setBusy(false); setError('Google 연결 창을 열지 못했습니다. 연결 설정과 팝업 권한을 확인해 주세요.');
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
