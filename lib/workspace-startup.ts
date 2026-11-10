import type { ChatGPTUser } from '../app/chatgpt-auth';
import { buildWorkspaceBootstrap, type WorkspaceBootstrap } from './workspace-bootstrap';

export type ConversationSummary = {
  id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
  pinned_at: number | null;
};

export type WorkspaceStartup = {
  bootstrap: WorkspaceBootstrap;
  // null means unavailable so far; [] is a successfully loaded empty history.
  chats: ConversationSummary[] | null;
};

// History is optional first-paint data. Leave time for the HTML, CSS and
// hydration inside the 500 ms UI target instead of spending 600 ms on D1.
export const WORKSPACE_HISTORY_RENDER_BUDGET_MS = 80;

export async function listWorkspaceConversations(database: D1Database, owner: string): Promise<ConversationSummary[]> {
  const result = await database.prepare(
    "SELECT id,title,model,created_at,updated_at,pinned_at FROM conversations WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs d WHERE d.user_id=conversations.user_id AND d.status='pending') ORDER BY (pinned_at IS NULL),pinned_at DESC,updated_at DESC LIMIT 200",
  ).bind(owner).all<ConversationSummary>();
  return result.results;
}

/** Request-scoped data only: never cache one visitor's identity or history for another. */
export async function loadWorkspaceStartup(
  user: ChatGPTUser,
  environment: Cloudflare.Env,
  historyTimeoutMs = WORKSPACE_HISTORY_RENDER_BUDGET_MS,
): Promise<WorkspaceStartup> {
  const bootstrap = buildWorkspaceBootstrap(user, environment);
  const historyBudget = Number.isFinite(historyTimeoutMs)
    ? Math.min(WORKSPACE_HISTORY_RENDER_BUDGET_MS, Math.max(0, historyTimeoutMs))
    : WORKSPACE_HISTORY_RENDER_BUDGET_MS;
  if (!environment.DB || historyBudget === 0) return { bootstrap, chats: null };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const chats = await Promise.race([
      // A late failed D1 request is handled even after the render budget expires.
      // null lets the client fetch history independently and display any error;
      // never manufacture an empty history or delay the authenticated shell.
      listWorkspaceConversations(environment.DB, user.userId).catch(() => null),
      new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), historyBudget); }),
    ]);
    return { bootstrap, chats };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
