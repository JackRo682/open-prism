'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export const THEME_STORAGE_KEY = 'prism-theme';
const THEME_EVENT = 'prism-theme-change';

function readTheme(): ThemePreference {
  try {
    const cookie = document.cookie.match(/(?:^|; )prism-theme=(system|light|dark)(?:;|$)/)?.[1];
    if (cookie === 'system' || cookie === 'light' || cookie === 'dark') return cookie;
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    if (value === 'system' || value === 'light' || value === 'dark') return value;
  } catch {
    // The selected theme still works when browser storage is unavailable.
  }
  return 'dark';
}

function applyTheme(preference: ThemePreference) {
  const dark = preference === 'dark' ||
    (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0f0f0f' : '#ffffff');
}

/** Keep the menu, all dialogs and other open tabs on the same theme. */
export function useWorkspaceTheme() {
  const [theme, setThemeState] = useState<ThemePreference>('dark');
  const preferenceRef = useRef<ThemePreference>('dark');

  useEffect(() => {
    const preference = readTheme();
    preferenceRef.current = preference;
    setThemeState(preference);
    applyTheme(preference);

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const readStoredPreference = () => {
      const next = readTheme();
      preferenceRef.current = next;
      setThemeState(next);
      applyTheme(next);
    };
    const refreshSystemTheme = () => applyTheme(preferenceRef.current);
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) readStoredPreference();
    };
    const onTheme = (event: Event) => {
      const next = (event as CustomEvent<ThemePreference>).detail;
      if (!['system', 'light', 'dark'].includes(next)) return;
      preferenceRef.current = next;
      setThemeState(next);
      applyTheme(next);
    };

    media.addEventListener('change', refreshSystemTheme);
    window.addEventListener('storage', onStorage);
    window.addEventListener(THEME_EVENT, onTheme);
    return () => {
      media.removeEventListener('change', refreshSystemTheme);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(THEME_EVENT, onTheme);
    };
  }, []);

  const setTheme = useCallback((preference: ThemePreference) => {
    try { localStorage.setItem(THEME_STORAGE_KEY, preference); } catch {}
    try { document.cookie = `${THEME_STORAGE_KEY}=${preference}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`; } catch {}
    preferenceRef.current = preference;
    setThemeState(preference);
    applyTheme(preference);
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: preference }));
  }, []);

  return { theme, setTheme };
}
