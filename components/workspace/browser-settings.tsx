'use client';

import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { AlertCircle, ChevronDown, LoaderCircle, Trash2 } from 'lucide-react';

export type BrowserPreferences = {
  browserTarget: 'current' | 'remote';
  browserPermission: 'ask' | 'approve';
};

export const BROWSER_PREFERENCES_KEY = 'prism.browser-preferences.v1';
export const BROWSER_PREFERENCES_EVENT = 'prism:browser-preferences-changed';

const defaultPreferences = (): BrowserPreferences => ({
  browserTarget: 'current',
  browserPermission: 'ask',
});

function readPreferences(value: unknown): BrowserPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultPreferences();
  }
  const input = value as Record<string, unknown>;
  return {
    browserTarget: input.browserTarget === 'remote' ? 'remote' : 'current',
    browserPermission: input.browserPermission === 'approve' ? 'approve' : 'ask',
  };
}

/** Guest preferences stay separate from authenticated account settings. */
export function readLocalBrowserPreferences(): BrowserPreferences {
  if (typeof window === 'undefined') return defaultPreferences();
  try {
    return readPreferences(JSON.parse(window.localStorage.getItem(BROWSER_PREFERENCES_KEY) || 'null'));
  } catch {
    return defaultPreferences();
  }
}

function notifyPreferences(preferences: BrowserPreferences) {
  window.dispatchEvent(new CustomEvent<BrowserPreferences>(BROWSER_PREFERENCES_EVENT, {
    detail: preferences,
  }));
}

async function requestPreferences(options: RequestInit): Promise<BrowserPreferences> {
  const response = await fetch('/api/settings', {
    credentials: 'same-origin',
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('설정 응답을 읽을 수 없습니다. 다시 시도해 주세요.');
  }
  if (!response.ok) {
    const error = data && typeof data === 'object' && 'error' in data ? data.error : null;
    throw new Error(typeof error === 'string' ? error
      : options.method === 'PATCH' ? '브라우저 설정을 저장하지 못했습니다.' : '브라우저 설정을 불러오지 못했습니다.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('설정 응답을 읽을 수 없습니다. 다시 시도해 주세요.');
  }
  return readPreferences(data);
}

export function BrowserSettingsPage({ signedIn, onNotice, remoteConfigured = false, onNavigate }: {
  signedIn: boolean;
  onNotice?: (message: string) => void;
  remoteConfigured?: boolean;
  onNavigate?: (path: string) => void;
}) {
  const [preferences, setPreferences] = useState<BrowserPreferences>(defaultPreferences);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const saveController = useRef<AbortController | null>(null);
  const deleteController = useRef<AbortController | null>(null);
  const saveInProgress = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setSaving(false);
    setError('');
    setSaved(false);
    if (!signedIn) {
      const local = readLocalBrowserPreferences();
      setPreferences(local);
      setLoaded(true);
      notifyPreferences(local);
    } else {
      requestPreferences({ signal: controller.signal })
        .then((next) => {
          if (controller.signal.aborted) return;
          setPreferences(next);
          setLoaded(true);
          notifyPreferences(next);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setError(cause instanceof Error ? cause.message : '설정을 불러오지 못했습니다.');
        });
    }
    return () => {
      controller.abort();
      saveController.current?.abort();
      deleteController.current?.abort();
      saveInProgress.current = false;
    };
  }, [signedIn, attempt]);

  async function save(patch: Partial<BrowserPreferences>) {
    if (!loaded || saveInProgress.current) return;
    const next = { ...preferences, ...patch };
    if (next.browserTarget === preferences.browserTarget
      && next.browserPermission === preferences.browserPermission) return;

    const controller = new AbortController();
    saveController.current = controller;
    saveInProgress.current = true;
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      let stored: BrowserPreferences;
      if (signedIn) {
        stored = await requestPreferences({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
          signal: controller.signal,
        });
      } else {
        try {
          window.localStorage.setItem(BROWSER_PREFERENCES_KEY, JSON.stringify(next));
        } catch {
          throw new Error('이 브라우저에 설정을 저장할 수 없습니다. 브라우저의 저장 공간 설정을 확인해 주세요.');
        }
        stored = next;
      }
      if (controller.signal.aborted) return;
      setPreferences(stored);
      setSaved(true);
      notifyPreferences(stored);
      onNotice?.(signedIn ? '브라우저 설정을 저장했습니다.' : '이 브라우저에 설정을 저장했습니다.');
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : '설정을 저장하지 못했습니다.');
      }
    } finally {
      if (saveController.current === controller) {
        saveInProgress.current = false;
        if (!controller.signal.aborted) setSaving(false);
      }
    }
  }

  async function deleteRemoteData() {
    if (deleting || !signedIn) return;
    const controller = new AbortController();
    deleteController.current = controller;
    setDeleting(true); setError(''); setDeleted(false);
    try {
      const response = await fetch('/api/browser/sessions', { method: 'DELETE', credentials: 'same-origin', signal: controller.signal });
      const result = await response.json() as { error?: string; deleted?: boolean };
      if (!response.ok || !result.deleted) throw new Error(result.error || '원격 브라우저 기록을 삭제하지 못했습니다.');
      if (!controller.signal.aborted) {
        setDeleted(true); setDeleteOpen(false);
        onNotice?.('저장된 원격 페이지와 미리보기를 삭제했습니다.');
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '원격 브라우저 기록을 삭제하지 못했습니다.');
    } finally { if (!controller.signal.aborted) setDeleting(false); }
  }

  function navigate(path: string) { if (onNavigate) onNavigate(path); else window.location.assign(path); }

  return (
    <section className="prism-browser-page" aria-labelledby="prism-browser-title">
      <header className="prism-browser-heading">
        <h1 id="prism-browser-title">브라우저</h1>
      </header>

      <section className="prism-browser-preferences" aria-labelledby="prism-browser-preferences-title">
        <h2 id="prism-browser-preferences-title">환경설정</h2>
        <p>Prism에서 웹 링크를 여는 방식을 선택하세요.</p>
        <fieldset className="prism-browser-options" disabled={!loaded || saving}>
          <legend className="prism-visually-hidden">사용할 브라우저</legend>
          <label className="prism-browser-option">
            <input
              type="radio"
              name="prism-browser-target"
              value="current"
              checked={preferences.browserTarget === 'current'}
              onChange={() => { void save({ browserTarget: 'current' }); }}
              aria-describedby="prism-browser-current-description"
            />
            <span>
              <strong>현재 브라우저 사용</strong>
              <span id="prism-browser-current-description">지금 사용 중인 브라우저의 새 탭에서 링크를 엽니다.</span>
            </span>
          </label>
          <label className="prism-browser-option">
            <input
              type="radio"
              name="prism-browser-target"
              value="remote"
              checked={preferences.browserTarget === 'remote'}
              onChange={() => { void save({ browserTarget: 'remote' }); }}
              aria-describedby="prism-browser-remote-description"
            />
            <span>
              <strong>원격 브라우저만 사용</strong>
              <span id="prism-browser-remote-description">{remoteConfigured ? '격리된 원격 브라우저에서 페이지를 읽고 미리보기를 저장합니다.' : '원격 브라우저 연결이 필요합니다. 이 설정을 선택하면 현재 기기에서 외부 링크를 열지 않습니다.'}</span>
            </span>
          </label>
        </fieldset>
        {!remoteConfigured && <button type="button" className="prism-action-button" onClick={() => navigate('/settings')}>원격 브라우저 연결 상태 확인</button>}
        {remoteConfigured && <button type="button" className="prism-action-button" onClick={() => navigate('/browser')}>원격 브라우저 열기</button>}
      </section>

      <section className="prism-browser-row" aria-labelledby="prism-browser-permission-title">
        <div>
          <h2 id="prism-browser-permission-title">권한</h2>
          <p id="prism-browser-permission-description">Prism에서 외부 링크를 열기 전에 확인할지 선택하세요. 선택한 브라우저 방식에 적용됩니다.</p>
        </div>
        <div className="prism-browser-select">
          <select
            value={preferences.browserPermission}
            disabled={!loaded || saving}
            aria-labelledby="prism-browser-permission-title"
            aria-describedby="prism-browser-permission-description"
            onChange={(event) => {
              const permission = event.target.value;
              if (permission === 'ask' || permission === 'approve') {
                void save({ browserPermission: permission });
              }
            }}
          >
            <option value="ask">항상 묻기</option>
            <option value="approve">확인 없이 열기</option>
          </select>
          <ChevronDown size={16} aria-hidden="true" />
        </div>
      </section>

      <section className="prism-browser-row prism-browser-data" aria-labelledby="prism-browser-data-title">
        <div>
          <h2 id="prism-browser-data-title">원격 브라우저 데이터 삭제</h2>
          <p id="prism-browser-data-description">Prism에 저장된 원격 페이지 주소, 본문, 미리보기를 삭제합니다. 원격 세션과 쿠키는 각 요청이 끝나면 종료되며, 현재 기기의 브라우저 데이터는 변경하지 않습니다.</p>
        </div>
        <button
          className="prism-browser-delete"
          type="button"
          disabled={deleting}
          onClick={() => { if (!signedIn) { navigate('/login'); return; } setDeleted(false); setDeleteOpen(true); }}
          aria-describedby="prism-browser-data-description"
        ><Trash2 size={18} aria-hidden="true" />{signedIn ? '삭제' : '로그인 후 삭제'}</button>
      </section>
      {deleted && <p className="prism-browser-local-note" role="status">저장된 원격 페이지와 미리보기를 삭제했습니다.</p>}

      <div className="prism-browser-status" aria-live="polite" aria-atomic="true">
        {saving || (!loaded && !error)
          ? <p><LoaderCircle size={16} className="spin" aria-hidden="true" />{saving ? '저장 중…' : '설정 불러오는 중…'}</p>
          : saved ? <p>설정이 저장되었습니다.</p> : null}
      </div>
      {error && <div className="prism-browser-error" role="alert">
        <p><AlertCircle size={17} aria-hidden="true" />{error}</p>
        {!loaded && <button type="button" onClick={() => setAttempt((value) => value + 1)}>다시 시도</button>}
      </div>}
      {!signedIn && <p className="prism-browser-local-note">로그인하지 않은 상태에서는 이 브라우저에 설정이 저장됩니다.</p>}
      <Dialog.Root open={deleteOpen} onOpenChange={open => { if (!deleting) setDeleteOpen(open); }}>
        <Dialog.Portal><Dialog.Overlay className="prism-dialog-overlay" /><Dialog.Content className="prism-confirm-dialog prism-integration-confirm">
          <Dialog.Title>원격 브라우저 기록을 삭제할까요?</Dialog.Title>
          <Dialog.Description>내 계정에 저장된 원격 페이지 본문과 미리보기를 모두 삭제합니다. 삭제한 기록은 복원할 수 없습니다.</Dialog.Description>
          {error && <p role="alert" className="prism-form-error">{error}</p>}
          <div className="prism-setting-actions"><Dialog.Close asChild><button type="button" className="prism-action-button" disabled={deleting}>취소</button></Dialog.Close><button type="button" className="prism-action-button danger" disabled={deleting} onClick={() => { void deleteRemoteData(); }}>{deleting ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}기록 삭제</button></div>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
