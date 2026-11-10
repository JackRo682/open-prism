/**
 * Views already rendered by the authenticated workspace stay in its client
 * shell. In particular, opening the account or any settings-menu destination
 * must not request another RSC page and reset the workspace before it appears.
 * Keep this an exact allowlist: authentication, API and unknown routes still
 * need normal server/framework navigation.
 */
const WORKSPACE_PATHS = new Set([
  '/', '/chat', '/history', '/library',
  '/settings', '/personalization-settings', '/gemini-spark', '/browser-settings',
  '/customize', '/customize/skills', '/gems/view', '/import', '/sharing', '/feedback',
  '/usage', '/billing', '/pricing',
  '/models', '/models/openai', '/models/anthropic', '/models/google',
  '/faq', '/docs', '/privacy', '/terms',
]);

const WORKSPACE_HISTORY_KEY = '__prismWorkspaceNavigation';

export type WorkspaceNavigationOptions = { replace?: boolean };
export type WorkspaceNavigationTarget =
  | { kind: 'workspace'; href: string; pathname: string }
  | { kind: 'router'; href: string }
  | { kind: 'blocked' };

/** Keep authentication, server endpoints and unknown routes with the framework. */
export function resolveWorkspaceNavigation(href: string, origin: string): WorkspaceNavigationTarget {
  // Do not pass executable URLs or ambiguous backslash/control-character URLs
  // to router.push either. All application callers use root-relative URLs.
  if (!href || href !== href.trim() || /[\\\u0000-\u001f\u007f]/.test(href)
    || (!href.startsWith('/') && !/^https?:\/\//i.test(href))) return { kind: 'blocked' };

  let target: URL;
  try { target = new URL(href, origin); } catch { return { kind: 'blocked' }; }
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) return { kind: 'blocked' };
  if (target.origin !== origin) return { kind: 'router', href: target.href };

  const pathname = target.pathname;
  const localHref = pathname + target.search + target.hash;
  const isWorkspace = WORKSPACE_PATHS.has(pathname)
    || /^\/chat\/[A-Za-z0-9_-]{1,160}$/.test(pathname);
  return isWorkspace
    ? { kind: 'workspace', href: localHref, pathname }
    : { kind: 'router', href: localHref };
}

type HistoryHost = {
  location: Pick<Location, 'href' | 'origin' | 'pathname' | 'search' | 'hash'>;
  history: Pick<History, 'state' | 'pushState' | 'replaceState'>;
};

function historyState(state: unknown): Record<string, unknown> {
  return {
    ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}),
    [WORKSPACE_HISTORY_KEY]: 1,
  };
}

function isWorkspaceHistoryState(state: unknown): boolean {
  return !!state && typeof state === 'object'
    && (state as Record<string, unknown>)[WORKSPACE_HISTORY_KEY] === 1;
}

/** Mark the initial entry as well, so Back to its chat/settings view keeps this shell. */
export function initializeWorkspaceHistory(host: HistoryHost): void {
  if (resolveWorkspaceNavigation(host.location.href, host.location.origin).kind !== 'workspace') return;
  if (!isWorkspaceHistoryState(host.history.state)) {
    host.history.replaceState(historyState(host.history.state), '', host.location.href);
  }
}

/** Returns false for routes that need normal framework navigation. */
export function navigateWorkspaceHistory(
  host: HistoryHost,
  href: string,
  onPathname: (pathname: string) => void,
  options: WorkspaceNavigationOptions = {},
): boolean {
  const target = resolveWorkspaceNavigation(href, host.location.origin);
  if (target.kind !== 'workspace') return false;
  initializeWorkspaceHistory(host);
  const current = host.location.pathname + host.location.search + host.location.hash;
  if (target.href !== current) {
    const method = options.replace ? 'replaceState' : 'pushState';
    host.history[method](historyState(host.history.state), '', target.href);
  }
  onPathname(target.pathname);
  return true;
}

/**
 * Only intercept entries created by this workspace. Vinext otherwise restores
 * an RSC page on popstate, remounting this client-owned conversation workspace.
 */
export function restoreWorkspaceHistory(
  host: HistoryHost,
  event: Pick<PopStateEvent, 'state' | 'stopImmediatePropagation'>,
  onPathname: (pathname: string) => void,
): boolean {
  if (!isWorkspaceHistoryState(event.state)) return false;
  const target = resolveWorkspaceNavigation(host.location.href, host.location.origin);
  if (target.kind !== 'workspace') return false;
  event.stopImmediatePropagation();
  // Native history is patched by the framework to notify usePathname and
  // useSearchParams subscribers. Notify them without requesting an RSC tree.
  host.history.replaceState(historyState(host.history.state), '', target.href);
  onPathname(target.pathname);
  return true;
}

type ShortcutEvent = {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  code?: string;
  key?: string;
  keyCode?: number;
};

export function isNewChatShortcut(event: ShortcutEvent): boolean {
  return !event.defaultPrevented && !event.repeat && !event.altKey
    && !event.isComposing && event.keyCode !== 229
    && (event.ctrlKey || event.metaKey) && event.shiftKey
    && (event.code === 'KeyO' || event.key?.toLowerCase() === 'o');
}
