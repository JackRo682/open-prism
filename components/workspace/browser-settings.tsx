'use client';

import { useEffect, useRef, useState } from 'react';
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

export function BrowserSettingsPage({ signedIn, onNotice }: {
  signedIn: boolean;
  onNotice?: (message: string) => void;
}) {
  const [preferences, setPreferences] = useState<BrowserPreferences>(defaultPreferences);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const saveController = useRef<AbortController | null>(null);
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
          <label className="prism-browser-option is-unavailable">
            <input
              type="radio"
              name="prism-browser-target"
              value="remote"
              checked={preferences.browserTarget === 'remote'}
              disabled
              aria-describedby="prism-browser-remote-description"
            />
            <span>
              <strong>원격 브라우저만 사용</strong>
              <span id="prism-browser-remote-description">원격 브라우저 서비스가 아직 연결되지 않았습니다.</span>
            </span>
          </label>
        </fieldset>
      </section>

      <section className="prism-browser-row" aria-labelledby="prism-browser-permission-title">
        <div>
          <h2 id="prism-browser-permission-title">권한</h2>
          <p id="prism-browser-permission-description">Prism에서 외부 링크를 열기 전에 확인할지 선택하세요. 현재 브라우저의 새 탭에 적용됩니다.</p>
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
          <p id="prism-browser-data-description">원격 브라우저 세션이 없어 삭제할 사용 기록과 쿠키가 없습니다. 현재 기기의 데이터는 브라우저 설정에서 관리할 수 있습니다.</p>
        </div>
        <button
          className="prism-browser-delete"
          type="button"
          disabled
          aria-describedby="prism-browser-data-description"
        ><Trash2 size={18} aria-hidden="true" />삭제</button>
      </section>

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
    </section>
  );
}
