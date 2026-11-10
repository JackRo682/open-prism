import { BillingError } from './billing';
import { publicMessageContent } from './workspace-settings';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
} });
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
function fail(message: string, status = 400, code = 'INVALID_SHARE_REQUEST'): never { throw new BillingError(message, status, code); }
const unavailable = () => json({ error: '이 공유 링크는 만료되었거나 공유가 취소되어 열 수 없습니다.' }, 404);

export type PublicShareMessage = { role: 'user' | 'assistant'; content: string; model: string | null; created_at: number };

/** Allowlist public fields on both write and read, including legacy snapshots.
 * Private files, usage records, account identifiers and tool metadata never
 * become public just because a stored message gains another field. */
export function publicShareMessages(value: unknown): PublicShareMessage[] {
  if (!Array.isArray(value)) throw new Error('Invalid share snapshot.');
  return value.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const message = raw as Record<string, unknown>;
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') return [];
    return [{ role: message.role, content: publicMessageContent(message.content),
      model: typeof message.model === 'string' ? message.model : null,
      created_at: typeof message.created_at === 'number' && Number.isFinite(message.created_at) ? message.created_at : 0 }];
  });
}

function expiry(value: unknown, now: number, defaultAllowed: boolean): number | null {
  if (value === undefined && defaultAllowed) return now + 7 * 86_400_000;
  if (value === null) return null; // Explicitly chosen; never the creation default.
  if (value !== 1 && value !== 7 && value !== 30) fail('링크 만료 기간을 1일, 7일, 30일 또는 만료 없음으로 선택해주세요.');
  return now + (value as number) * 86_400_000;
}

async function preview(sql: D1Database, owner: string, conversationId: unknown) {
  if (!validId(conversationId)) fail('공유할 대화를 선택해주세요.');
  const chat = await sql.prepare('SELECT id,title FROM conversations WHERE id=? AND user_id=?')
    .bind(conversationId, owner).first<{ id: string; title: string }>();
  if (!chat) fail('Conversation not found.', 404, 'CONVERSATION_NOT_FOUND');
  const rows = (await sql.prepare(`SELECT m.role,m.content,m.model,m.created_at FROM messages m
    JOIN conversations c ON c.id=m.conversation_id WHERE c.id=? AND c.user_id=? ORDER BY m.created_at,m.rowid`)
    .bind(chat.id, owner).all()).results;
  const messages = publicShareMessages(rows);
  if (!messages.length) fail('메시지를 보낸 뒤 대화를 공유해주세요.');
  const snapshot = JSON.stringify(messages);
  if (new TextEncoder().encode(snapshot).length > 1_000_000) fail('공유할 대화가 너무 큽니다. 더 짧은 대화를 선택해주세요.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([chat.title, snapshot])));
  const previewHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { conversationId: chat.id, title: chat.title, messages, snapshot, previewHash };
}

/** Shared by the public JSON endpoint and SSR page: an expired capability is
 * unavailable regardless of which rendering path a visitor uses. */
export async function readPublicShare(sql: D1Database, token: string, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const share = await sql.prepare(`SELECT s.title,s.snapshot,s.created_at,s.expires_at FROM public_shares s
    JOIN conversations c ON c.id=s.conversation_id AND c.user_id=s.user_id
    WHERE s.token=? AND (s.expires_at IS NULL OR s.expires_at>?)
    AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs d WHERE d.user_id=s.user_id AND d.status='pending')`)
    .bind(token, now).first<{ title: string; snapshot: string; created_at: number; expires_at: number | null }>();
  if (!share) return null;
  try {
    return { title: share.title, created_at: share.created_at, expires_at: share.expires_at,
      messages: publicShareMessages(JSON.parse(share.snapshot)) };
  } catch { return null; }
}

export async function publicShareResponse(sql: D1Database, token: string) {
  const share = await readPublicShare(sql, token);
  return share ? json(share) : unavailable();
}

export async function handlePublicShares(req: Request, path: string[], sql: D1Database, owner: string): Promise<Response | null> {
  if (path[0] !== 'shares') return null;
  if (path.length === 2 && path[1] === 'preview' && req.method === 'GET') {
    const { snapshot: _snapshot, ...safe } = await preview(sql, owner, new URL(req.url).searchParams.get('conversationId'));
    return json(safe);
  }
  if (path.length === 1 && req.method === 'GET') {
    const shares = (await sql.prepare(`SELECT id,token,title,conversation_id,created_at,expires_at
      FROM public_shares WHERE user_id=? ORDER BY created_at DESC`).bind(owner).all<{ expires_at: number | null }>()).results;
    const now = Date.now();
    return json({ shares: shares.map(share => ({ ...share, status: share.expires_at !== null && share.expires_at <= now ? 'expired' : 'active' })) });
  }
  if (path.length === 1 && req.method === 'POST') {
    const raw: unknown = await req.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('공유할 대화와 공개 여부를 확인해주세요.');
    const body = raw as Record<string, unknown>;
    if (body.privacyConfirmed !== true) fail('미리보기에서 공개할 내용을 확인하고 공유에 동의해주세요.', 400, 'SHARE_CONFIRMATION_REQUIRED');
    if (typeof body.previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.previewHash)) fail('대화 미리보기를 다시 확인해주세요.', 409, 'SHARE_PREVIEW_REQUIRED');
    const now = Date.now(), expiresAt = expiry(body.expiresInDays, now, true);
    const reviewed = await preview(sql, owner, body.conversationId);
    if (reviewed.previewHash !== body.previewHash) fail('대화가 변경되었습니다. 미리보기를 새로 불러온 뒤 다시 확인해주세요.', 409, 'SHARE_PREVIEW_CHANGED');
    const id = crypto.randomUUID(), token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    const created = await sql.prepare(`INSERT INTO public_shares (id,user_id,conversation_id,token,title,snapshot,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM public_shares WHERE user_id=?)<100
      AND EXISTS (SELECT 1 FROM conversations WHERE id=? AND user_id=?) RETURNING id`)
      .bind(id, owner, reviewed.conversationId, token, reviewed.title, reviewed.snapshot, now, expiresAt, owner, reviewed.conversationId, owner).first();
    if (!created) fail('공유할 대화를 확인하거나 기존 공개 링크를 삭제한 뒤 다시 시도해주세요. 공개 링크는 최대 100개까지 보관됩니다.');
    return json({ id, token, url: new URL('/share/' + token, req.url).href, expires_at: expiresAt }, 201);
  }
  if (path.length === 2 && validId(path[1]) && req.method === 'PATCH') {
    const body: unknown = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('링크 만료 기간을 선택해주세요.');
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some(key => key !== 'expiresInDays')) fail('링크 만료 기간만 변경할 수 있습니다.');
    const now = Date.now(), expiresAt = expiry(input.expiresInDays, now, false);
    // Expired tokens cannot be revived. A new review creates a fresh capability.
    const result = await sql.prepare(`UPDATE public_shares SET expires_at=? WHERE id=? AND user_id=?
      AND (expires_at IS NULL OR expires_at>?) RETURNING id,expires_at`)
      .bind(expiresAt, path[1], owner, now).first();
    return result ? json({ ...result, status: 'active' }) : unavailable();
  }
  if (path.length === 2 && validId(path[1]) && req.method === 'DELETE') {
    const removed = await sql.prepare('DELETE FROM public_shares WHERE id=? AND user_id=? RETURNING id').bind(path[1], owner).first();
    return removed ? json({ ok: true }) : unavailable();
  }
  return json({ error: 'Endpoint not found.' }, 404);
}
