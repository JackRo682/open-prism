'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  initializeWorkspaceHistory,
  navigateWorkspaceHistory,
  resolveWorkspaceNavigation,
  restoreWorkspaceHistory,
  type WorkspaceNavigationOptions,
} from '../lib/workspace-navigation';

/** Preserve the signed-in client shell while selecting its existing views. */
export function useWorkspaceNavigation(initialPathname: string) {
  const router = useRouter();
  // A server-provided pathname also avoids a temporary '/' during hydration.
  const [pathname, setPathname] = useState(initialPathname);

  useEffect(() => {
    initializeWorkspaceHistory(window);
    setPathname(window.location.pathname);
    const onPopState = (event: PopStateEvent) => {
      if (!restoreWorkspaceHistory(window, event, setPathname)) {
        // Let the framework restore other views, including its same-route
        // scroll-only branch, while keeping our local route state current.
        setPathname(window.location.pathname);
      }
    };
    // Capture only our tagged entries before the framework's RSC pop handler.
    window.addEventListener('popstate', onPopState, true);
    return () => window.removeEventListener('popstate', onPopState, true);
  }, [initialPathname]);

  const navigate = useCallback((href: string, options: WorkspaceNavigationOptions = {}) => {
    if (navigateWorkspaceHistory(window, href, setPathname, options)) return;
    const target = resolveWorkspaceNavigation(href, window.location.origin);
    if (target.kind === 'router') {
      if (options.replace) router.replace(target.href);
      else router.push(target.href);
    }
  }, [router]);

  return { pathname, navigate };
}
