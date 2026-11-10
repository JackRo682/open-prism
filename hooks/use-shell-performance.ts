'use client';

import { useEffect } from 'react';

/** Local, opt-in timings for release checks. Never sends telemetry or user data. */
export function useShellPerformance() {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('performance') !== '1') return;
    const root = document.querySelector<HTMLElement>('.prism-guest, .gemini-shell');
    if (!root) return;
    let active = true;
    let firstFrame = 0;
    let secondFrame = 0;
    const frames = new Set<number>();
    const hydrated = performance.now();
    root.dataset.prismHydratedMs = hydrated.toFixed(1);
    // Record completion separately from hydration: the decorative entrance
    // can still be running after controls have their event handlers attached.
    const finiteAnimations = root.getAnimations({ subtree: true }).filter(animation =>
      Number.isFinite(animation.effect?.getComputedTiming().endTime),
    );
    void Promise.allSettled(finiteAnimations.map(animation => animation.finished)).then(() => {
      if (active) root.dataset.prismInitialMotionEndMs = performance.now().toFixed(1);
    });
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (navigation) {
      root.dataset.prismResponseStartMs = navigation.responseStart.toFixed(1);
      root.dataset.prismResponseEndMs = navigation.responseEnd.toFixed(1);
      root.dataset.prismHydrationAfterResponseMs = (hydrated - navigation.responseEnd).toFixed(1);
    }
    const updatePaint = () => {
      const paint = performance.getEntriesByName('first-contentful-paint')[0];
      if (paint) root.dataset.prismFirstPaintMs = paint.startTime.toFixed(1);
    };
    updatePaint();
    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (!active) return;
        root.dataset.prismInteractivePaintMs = performance.now().toFixed(1);
        updatePaint();
      });
    });
    // Measure a real trusted click through the following painted frame. Keep
    // the label generic: no message text, account details or URLs are recorded.
    const measureClick = (event: MouseEvent) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const button = event.target.closest('button');
      if (!button || !root.contains(button)) return;
      const started = performance.now();
      const frame = requestAnimationFrame(() => {
        frames.delete(frame);
        const painted = requestAnimationFrame(() => {
          frames.delete(painted);
          if (!active) return;
          root.dataset.prismLastInteractionMs = (performance.now() - started).toFixed(1);
          root.dataset.prismInteractionCount = String(Number(root.dataset.prismInteractionCount || 0) + 1);
        });
        frames.add(painted);
      });
      frames.add(frame);
    };
    document.addEventListener('click', measureClick, true);
    return () => {
      active = false;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      for (const frame of frames) cancelAnimationFrame(frame);
      document.removeEventListener('click', measureClick, true);
    };
  }, []);
}
