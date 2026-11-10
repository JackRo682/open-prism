import { BillingError } from './billing';
import { findModel } from './models';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
function fail(message: string, status = 400, code = 'INVALID_CONVERSATION_ACTION'): never { throw new BillingError(message, status, code); }
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('올바른 요청을 입력해주세요.');
  return value as Record<string, unknown>;
}

export type SavedMessage = {
  id: string; role: 'user' | 'assistant'; content: string; model: string | null;
  created_at: number; usage_id: string | null; feedback?: 'up' | 'down' | null;
};

export async function listConversationMessages(sql: D1Database, owner: string, conversationId: string) {
  const rows = (await sql.prepare(`SELECT m.id,m.role,m.content,m.model,m.created_at,m.usage_id,f.rating AS feedback
    FROM messages m JOIN conversations c ON c.id=m.conversation_id
    LEFT JOIN message_feedback f ON f.message_id=m.id AND f.user_id=c.user_id
    WHERE c.id=? AND c.user_id=? ORDER BY m.created_at,m.rowid`).bind(conversationId, owner).all<SavedMessage>()).results;
  return rows.map(message => ({ ...message, ...(message.role === 'user' ? { prompt_text: message.content.split(/\n\n<attached_document\b/, 1)[0] } : {}) }));
}

export async function patchConversation(sql: D1Database, owner: string, id: string, value: unknown) {
  const body = object(value);
  if (!Object.keys(body).length || Object.keys(body).some(key => key !== 'title' && key !== 'pinned')) fail('대화 이름 또는 고정 상태를 지정해주세요.');
  const rename = Object.hasOwn(body, 'title'), pin = Object.hasOwn(body, 'pinned');
  if (rename && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 100 || body.title.includes('\0'))) fail('대화 이름을 1~100자로 입력해주세요.');
  if (pin && typeof body.pinned !== 'boolean') fail('고정 상태가 올바르지 않습니다.');
  const now = Date.now();
  const chat = await sql.prepare(`UPDATE conversations SET
    title=CASE WHEN ? THEN ? ELSE title END,
    updated_at=CASE WHEN ? THEN ? ELSE updated_at END,
    pinned_at=CASE WHEN ? THEN CASE WHEN ? THEN COALESCE(pinned_at,?) ELSE NULL END ELSE pinned_at END
    WHERE id=? AND user_id=? RETURNING id,title,model,created_at,updated_at,pinned_at`)
    .bind(Number(rename), rename ? (body.title as string).trim() : '', Number(rename), now, Number(pin), Number(body.pinned === true), now, id, owner).first();
  if (!chat) fail('Conversation not found.', 404, 'CONVERSATION_NOT_FOUND');
  return { ok: true, conversation: chat };
}

async function ownedMessage(sql: D1Database, owner: string, conversationId: string, messageId: string) {
  return sql.prepare(`SELECT m.id,m.role,m.content,m.model,m.created_at,m.usage_id,c.title
    FROM messages m JOIN conversations c ON c.id=m.conversation_id
    WHERE c.id=? AND c.user_id=? AND m.id=?`).bind(conversationId, owner, messageId).first<SavedMessage & { title: string }>();
}

function matchesReport(report: Record<string, unknown>, conversationId: string, messageId: string, category: unknown, details: string) {
  // Foreign keys can be cleared by a later edit or deletion. The submitted
  // evidence retains the original target so the same request stays idempotent.
  let snapshot: { conversationId?: string; messageId?: string } = {};
  try { snapshot = JSON.parse(String(report.snapshot)); } catch { /* Older evidence may omit target IDs. */ }
  return (snapshot.conversationId || report.conversation_id) === conversationId
    && (snapshot.messageId || report.message_id) === messageId && report.category === category && report.details === details;
}

export async function handleConversationActions(req: Request, path: string[], sql: D1Database, owner: string, adminId?: string): Promise<Response | null> {
  if (path[0] === 'chat' && path[1] === 'operations' && path.length === 3 && req.method === 'GET') {
    const by = new URL(req.url).searchParams.get('by');
    if (by !== null && by !== 'client') return json({ error: '요청 조회 방식을 확인해주세요.' }, 400);
    if (!validId(path[2]) || (by === 'client' && !/^[A-Za-z0-9_-]{8,100}$/.test(path[2]))) return json({ error: '요청을 찾을 수 없습니다.' }, 404);
    // A disconnect can hide the final SSE event after its transaction commits.
    // The client key is available even when the first SSE event never arrived.
    // Both predicates use an indexed key scoped to the authenticated owner.
    const keyColumn = by === 'client' ? 'client_request_id' : 'id';
    const operation = await sql.prepare(`SELECT id AS requestId,status,conversation_id AS conversationId,
      user_message_id AS userMessageId,assistant_message_id AS assistantMessageId,error
      FROM chat_operations WHERE user_id=? AND ${keyColumn}=?`).bind(owner, path[2]).first();
    return operation ? json(operation) : json({ error: '요청을 찾을 수 없습니다.' }, 404);
  }
  if (path[0] === 'admin' && path[1] === 'reports') {
    if (!adminId || owner !== adminId) return json({ error: 'Administrator access required.' }, 403);
    if (path.length === 2 && req.method === 'GET') {
      const reports = (await sql.prepare('SELECT id,user_id,conversation_id,message_id,category,details,snapshot,status,resolution,created_at,updated_at FROM conversation_reports ORDER BY created_at DESC LIMIT 100').all()).results;
      return json({ reports });
    }
    if (path.length === 3 && req.method === 'PATCH') {
      const body = object(await req.json());
      if (!['submitted', 'reviewing', 'resolved', 'dismissed'].includes(String(body.status))) fail('신고 처리 상태가 올바르지 않습니다.');
      if (body.resolution !== undefined && (typeof body.resolution !== 'string' || body.resolution.length > 5000)) fail('처리 메모는 5,000자 이하로 입력해주세요.');
      const report = await sql.prepare('UPDATE conversation_reports SET status=?,resolution=?,updated_at=? WHERE id=? RETURNING id,status,resolution,created_at,updated_at')
        .bind(body.status as string, typeof body.resolution === 'string' ? body.resolution.trim() : null, Date.now(), path[2]).first();
      return report ? json(report) : json({ error: '신고를 찾을 수 없습니다.' }, 404);
    }
    return json({ error: 'Endpoint not found.' }, 404);
  }
  if (path[0] === 'reports' && path.length === 2 && req.method === 'GET') {
    const report = await sql.prepare('SELECT id,category,details,status,resolution,created_at,updated_at FROM conversation_reports WHERE id=? AND user_id=?').bind(path[1], owner).first();
    return report ? json(report) : json({ error: '신고를 찾을 수 없습니다.' }, 404);
  }
  if (path[0] !== 'conversations' || path.length < 3) return null;
  if (!validId(path[1])) fail('올바른 대화를 선택해주세요.');
  const conversationId = path[1];
  const chat = await sql.prepare('SELECT id,title FROM conversations WHERE id=? AND user_id=?').bind(conversationId, owner).first<{ id: string; title: string }>();
  if (!chat) return json({ error: 'Conversation not found.' }, 404);

  if (path[2] === 'messages' && path.length === 5) {
    if (!validId(path[3])) fail('올바른 메시지를 선택해주세요.');
    const message = await ownedMessage(sql, owner, conversationId, path[3]);
    if (!message) return json({ error: '메시지를 찾을 수 없습니다.' }, 404);
    if (path[4] === 'details' && req.method === 'GET') {
      const [usage, feedback] = await Promise.all([
        message.usage_id ? sql.prepare('SELECT input_tokens,output_tokens,duration,status,provider FROM usage WHERE id=? AND user_id=?').bind(message.usage_id, owner).first<{ input_tokens: number; output_tokens: number; duration: number; status: string; provider: string }>() : null,
        sql.prepare('SELECT rating,details,updated_at FROM message_feedback WHERE message_id=? AND user_id=?').bind(message.id, owner).first<{ rating: string; details: string; updated_at: number }>(),
      ]);
      return json({
        id: message.id, conversationId, role: message.role, model: message.model,
        provider: usage?.provider || (message.model ? findModel(message.model)?.provider : null) || null,
        createdAt: message.created_at,
        usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, durationMs: usage.duration, status: usage.status } : null,
        feedback: feedback ? { rating: feedback.rating, details: feedback.details, updatedAt: feedback.updated_at } : null,
      });
    }
    if (path[4] === 'feedback' && req.method === 'POST') {
      if (message.role !== 'assistant') fail('AI 응답에만 평가를 남길 수 있습니다.');
      const body = object(await req.json());
      if (body.rating !== 'up' && body.rating !== 'down' && body.rating !== null) fail('평가를 선택해주세요.');
      if (body.details !== undefined && (typeof body.details !== 'string' || body.details.length > 2000)) fail('의견은 2,000자 이하로 입력해주세요.');
      const now = Date.now();
      if (body.rating === null) await sql.prepare('DELETE FROM message_feedback WHERE message_id=? AND user_id=?').bind(message.id, owner).run();
      else await sql.prepare(`INSERT INTO message_feedback (message_id,user_id,rating,details,created_at,updated_at)
        SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.user_id=?)
        ON CONFLICT(message_id) DO UPDATE SET rating=excluded.rating,details=excluded.details,updated_at=excluded.updated_at WHERE user_id=excluded.user_id`)
        .bind(message.id, owner, body.rating, typeof body.details === 'string' ? body.details.trim() : '', now, now, message.id, owner).run();
      const saved = await sql.prepare('SELECT rating,details,updated_at FROM message_feedback WHERE message_id=? AND user_id=?').bind(message.id, owner).first<{ rating: string; details: string; updated_at: number }>();
      if (body.rating !== null && !saved) return json({ error: '응답이 변경되었습니다. 대화를 새로 불러온 뒤 다시 평가해주세요.' }, 409);
      return json({ messageId: message.id, rating: saved?.rating || null, details: saved?.details || '', updatedAt: saved?.updated_at || now });
    }
  }
  if (path[2] === 'revisions' && req.method === 'GET') {
    if (path.length === 3) {
      const revisions = (await sql.prepare('SELECT id,action,target_message_id,created_at FROM conversation_revisions WHERE conversation_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50').bind(conversationId, owner).all()).results;
      return json({ revisions });
    }
    if (path.length === 4) {
      const revision = await sql.prepare('SELECT id,action,target_message_id,created_at FROM conversation_revisions WHERE id=? AND conversation_id=? AND user_id=?').bind(path[3], conversationId, owner).first();
      if (!revision) return json({ error: '이전 대화 버전을 찾을 수 없습니다.' }, 404);
      const messages = (await sql.prepare('SELECT message_id AS id,role,content,model,usage_id,created_at FROM conversation_revision_messages WHERE revision_id=? ORDER BY created_at,original_order').bind(path[3]).all()).results;
      return json({ revision, messages });
    }
  }
  if (path[2] === 'reports' && path.length === 3 && req.method === 'POST') {
    const body = object(await req.json());
    if (!validId(body.messageId) || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId)) fail('신고할 메시지와 요청 ID를 확인해주세요.');
    const category = body.category === undefined ? 'legal' : body.category;
    if (!['legal', 'copyright', 'privacy', 'illegal', 'other'].includes(String(category))) fail('신고 유형을 선택해주세요.');
    if (typeof body.details !== 'string' || body.details.trim().length < 10 || body.details.length > 5000 || body.details.includes('\0')) fail('신고 내용을 10~5,000자로 입력해주세요.');
    const details = body.details.trim();
    const previous = await sql.prepare('SELECT id,conversation_id,message_id,category,details,snapshot,status,created_at FROM conversation_reports WHERE user_id=? AND request_id=?').bind(owner, body.requestId).first<Record<string, unknown>>();
    if (previous) {
      if (!matchesReport(previous, conversationId, body.messageId, category, details)) fail('이미 다른 신고에 사용한 요청 ID입니다.', 409, 'IDEMPOTENCY_CONFLICT');
      return json({ id: previous.id, status: previous.status, createdAt: previous.created_at, reused: true });
    }
    const message = await ownedMessage(sql, owner, conversationId, body.messageId);
    if (!message) return json({ error: '신고할 메시지를 찾을 수 없습니다.' }, 404);
    const now = Date.now(), day = Math.floor(now / 86400000) * 86400000, id = crypto.randomUUID();
    const snapshot = JSON.stringify({ conversationId, messageId: message.id, title: chat.title, role: message.role, content: message.content, model: message.model, createdAt: message.created_at });
    if (new TextEncoder().encode(snapshot).length > 1000000) fail('신고 대상 메시지가 너무 큽니다. 내용을 직접 요약해 문의해주세요.');
    const saved = await sql.prepare(`INSERT INTO conversation_reports (id,user_id,request_id,conversation_id,message_id,category,details,snapshot,status,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,'submitted',?,? WHERE (SELECT COUNT(*) FROM conversation_reports WHERE user_id=? AND created_at>=?)<20
      ON CONFLICT(user_id,request_id) DO NOTHING RETURNING id,status,created_at`)
      .bind(id, owner, body.requestId, conversationId, message.id, category as string, details, snapshot, now, now, owner, day).first<{ id: string; status: string; created_at: number }>();
    if (!saved) {
      const duplicate = await sql.prepare('SELECT id,status,created_at,conversation_id,message_id,category,details,snapshot FROM conversation_reports WHERE user_id=? AND request_id=?').bind(owner, body.requestId).first<Record<string, unknown>>();
      if (duplicate) {
        if (!matchesReport(duplicate, conversationId, message.id, category, details)) fail('이미 다른 신고에 사용한 요청 ID입니다.', 409, 'IDEMPOTENCY_CONFLICT');
        return json({ id: duplicate.id, status: duplicate.status, createdAt: duplicate.created_at, reused: true });
      }
      return json({ error: '오늘 접수할 수 있는 신고 수에 도달했습니다. 잠시 후 다시 시도해주세요.' }, 429);
    }
    return json({ id: saved.id, status: saved.status, createdAt: saved.created_at, reused: false }, 201);
  }
  return json({ error: 'Endpoint not found.' }, 404);
}
