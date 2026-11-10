'use client';

import { useEffect, useRef, useState } from 'react';

type WelcomePhase = 'pending' | 'entering' | 'complete';
const INTRO_DURATION_MS = 280;

/**
 * One entrance per mounted workspace, after client-only history is restored.
 * Keep this hook on the stable workspace rather than the conditional welcome
 * subtree: returning to an empty chat must not replay the page-load sequence.
 *
 * `pending` is rendered on the server as well as the first client render. The
 * matching CSS starts a short, decorative bloom at first paint. It never hides
 * or disables the greeting, composer, or menus while hydration/history is
 * pending. Switching to `entering` keeps the same animation, so hydration does
 * not restart the visual entrance.
 */
export function useWelcomeIntro({ active, ready = true }: { active: boolean; ready?: boolean }): WelcomePhase {
  const [phase, setPhase] = useState<WelcomePhase>(active ? 'pending' : 'complete');
  const decision = useRef<'animate' | 'skip' | null>(null);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!ready) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const desktop = window.matchMedia('(min-width: 769px)');
    if (decision.current === null) {
      decision.current = active && desktop.matches && !reducedMotion.matches ? 'animate' : 'skip';
    }
    if (!active || reducedMotion.matches || !desktop.matches) decision.current = 'skip';

    if (decision.current === 'skip') {
      setPhase('complete');
      return;
    }

    // Strict Mode may run setup/cleanup/setup. Retain the original start time
    // and recreate only the remaining timer, rather than abandoning/replaying
    // the sequence after the first cleanup.
    startedAt.current ??= performance.now();
    const finish = () => {
      decision.current = 'skip';
      setPhase('complete');
    };
    const remaining = INTRO_DURATION_MS - (performance.now() - startedAt.current);
    if (remaining <= 0) {
      finish();
      return;
    }

    setPhase('entering');
    const timer = window.setTimeout(finish, remaining);
    const preferenceChanged = () => {
      if (reducedMotion.matches || !desktop.matches) finish();
    };
    reducedMotion.addEventListener('change', preferenceChanged);
    desktop.addEventListener('change', preferenceChanged);
    return () => {
      window.clearTimeout(timer);
      reducedMotion.removeEventListener('change', preferenceChanged);
      desktop.removeEventListener('change', preferenceChanged);
    };
  }, [active, ready]);

  // Do not hide the restored conversation for even one commit while an effect
  // changes phase. The sequence is relevant only to the empty welcome view.
  return active ? phase : 'complete';
}
