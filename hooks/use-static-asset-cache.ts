'use client';

import { useEffect } from 'react';

const WORKER_PATH = '/prism-static-sw.js';
const MAX_WARM_URLS = 32;

/** Public build assets only; registration/warming never blocks the usable UI. */
export function useStaticAssetCache() {
  useEffect(() => {
    const development = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV;
    if (development || !window.isSecureContext || !('serviceWorker' in navigator)
      || /^(?:localhost|127\.0\.0\.1|\[?::1\]?|terminal\.local)$/.test(window.location.hostname)) return;

    let active = true, firstFrame = 0, secondFrame = 0;
    let idle: number | undefined, fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let registration: ServiceWorkerRegistration | undefined;
    const workerUrl = new URL(WORKER_PATH, window.location.origin).href;
    const requestId = crypto.randomUUID();
    const diagnostics = new URLSearchParams(window.location.search).get('performance') === '1';
    const ours = (worker: ServiceWorker | null | undefined) => worker?.scriptURL === workerUrl;
    function report(status: string, count?: number) {
      if (!active || !diagnostics) return;
      for (const root of document.querySelectorAll<HTMLElement>('.prism-guest, .gemini-shell')) {
        root.dataset.prismAssetCache = status;
        root.dataset.prismAssetCacheControlled = String(ours(navigator.serviceWorker.controller));
        if (count !== undefined) root.dataset.prismAssetCacheCount = String(count);
      }
    }
    const controlled = () => { if (ours(navigator.serviceWorker.controller)) report('controlled'); };
    const message = (event: MessageEvent) => {
      const data = event.data;
      if (!active || event.origin !== window.location.origin || !ours(event.source as ServiceWorker | null)
        || data?.type !== 'PRISM_STATIC_WARMED_V1' || data.requestId !== requestId
        || !Number.isInteger(data.cachedCount) || data.cachedCount < 0 || data.cachedCount > MAX_WARM_URLS) return;
      report(data.cachedCount > 0 ? 'warmed' : 'unavailable', data.cachedCount);
    };
    navigator.serviceWorker.addEventListener('controllerchange', controlled);
    navigator.serviceWorker.addEventListener('message', message);
    report(ours(navigator.serviceWorker.controller) ? 'controlled' : 'scheduled');

    async function register() {
      try {
        const existing = await navigator.serviceWorker.getRegistration('/');
        // Do not replace another application's worker at this origin.
        if (existing && [existing.active, existing.installing, existing.waiting].some(worker => worker && !ours(worker))) {
          report('unavailable'); return;
        }
        if (!active) return;
        registration = await navigator.serviceWorker.register(WORKER_PATH, { scope: '/', updateViaCache: 'none' });
        if (!active) return;
        report(ours(navigator.serviceWorker.controller) ? 'controlled' : 'registered');
        const ready = await navigator.serviceWorker.ready;
        if (!active || ready.scope !== new URL('/', window.location.origin).href || !ours(ready.active)) return;
        controlled();
        const urls = [...new Set(performance.getEntriesByType('resource').map(entry => entry.name).filter(value => {
          try {
            const url = new URL(value);
            return url.origin === window.location.origin && !url.search && !url.hash
              && (/^\/_next\/static\/chunks\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js$/.test(url.pathname)
                || /^\/_next\/static\/css\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}\.css$/.test(url.pathname));
          } catch { return false; }
        }))].slice(0, MAX_WARM_URLS);
        ready.active?.postMessage({ type: 'PRISM_STATIC_WARM_V1', requestId, urls });
      } catch { report('unavailable'); }
    }
    function schedule() {
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          if (!active) return;
          if ('requestIdleCallback' in window) idle = window.requestIdleCallback(() => { void register(); }, { timeout: 5000 });
          else fallbackTimer = setTimeout(() => { void register(); }, 1000);
        });
      });
    }
    if (document.readyState === 'complete') schedule();
    else window.addEventListener('load', schedule, { once: true });
    return () => {
      active = false;
      window.removeEventListener('load', schedule);
      navigator.serviceWorker.removeEventListener('controllerchange', controlled);
      navigator.serviceWorker.removeEventListener('message', message);
      cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    };
  }, []);
}
