import { acquireRequestLease, releaseRequestLease, requestLeaseIsCurrent, requestLeaseFence, type RequestLease } from './request-lease';
import { BillingError, balance, cost, getBillingConfig, reserve, settle } from './billing';
import { BETA_INPUT_BYTES, betaTextOutput, reserveBeta } from './beta';
import { fallbackChatTitle, generateChatTitle } from './chat-title';
import { AVAILABLE_CHAT_MODELS, findModel, isFreeModel, PROVIDERS } from './models';
import { invokeProvider, ProviderError, PROVIDER_INPUT_OVERHEAD_BYTES, withUntrustedDocuments, type Turn, type Usage } from './provider';
import { getWorkspaceSettings, withWorkspaceContext } from './workspace-settings';
import { betaDailyLimit, getWorkspaceCapabilities, validateToolRequest, withToolContext, WorkspaceToolError } from './workspace-tools';
import { deleteWorkArtifacts, storeWorkArtifacts } from './work-artifacts';
import { isRegenerateStyle, withRegenerateStyle } from './regenerate-style';
import { recordGenerationOutcome, trackProviderAttempt } from './security-monitoring';
import { isOwnedObjectKey, MAX_TEXT_FILE_BYTES } from './upload-security';

type ChatAction = 'append' | 'edit' | 'regenerate';
type StoredTurn = Turn & { id: string; model: string | null; created_at: number; usage_id: string | null; original_order: number };
type ChatOperation = {
  id: string; user_id: string; client_request_id: string; request_hash: string; conversation_id: string;
  action: ChatAction; target_message_id: string | null; user_message_id: string; assistant_message_id: string;
  status: 'preparing' | 'running' | 'complete' | 'error'; error: string | null; created_at: number; updated_at: number;
};
type GenerationPlan = { prompt: string; history: Turn[]; userMessageId: string; userCreatedAt: number; archiveFrom?: StoredTurn };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const uid = () => crypto.randomUUID();
const backgroundResponses = new WeakSet<Response>();
export const hasChatBackgroundWork = (response: Response) => backgroundResponses.has(response);
function reject(message: string, status = 400, code = 'INVALID_CHAT_REQUEST'): never { throw new BillingError(message, status, code); }
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const publicChatError = (error: unknown) => error instanceof Error && error.name === 'AbortError'
  ? '응답 시간이 초과되었거나 중지되었습니다.'
  : error instanceof BillingError || error instanceof WorkspaceToolError || error instanceof ProviderError
    ? error.message : '응답을 완료하지 못했습니다. 잠시 후 다시 시도해주세요.';
const streamHeaders = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff' };
const turnColumns = 'id,role,content,model,created_at,usage_id,rowid AS original_order';
const fromBoundary = '(created_at>? OR (created_at=? AND rowid>=?))';

async function requestHash(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function replayOperation(sql: D1Database, owner: string, operation: ChatOperation, hash: string): Promise<Response> {
  if (operation.request_hash !== hash) return json({ error: '같은 요청 ID로 다른 메시지를 보낼 수 없습니다.', code: 'IDEMPOTENCY_CONFLICT' }, 409);
  if (operation.status !== 'complete') {
    const pending = operation.status === 'preparing' || operation.status === 'running';
    return json({ error: pending ? '같은 요청이 이미 처리 중입니다. 완료 후 대화를 다시 확인해주세요.' : '이미 처리된 요청입니다. 다시 생성하려면 새 요청으로 시도해주세요.', code: pending ? 'REQUEST_IN_PROGRESS' : 'REQUEST_ALREADY_ATTEMPTED', requestId: operation.id, conversationId: operation.conversation_id }, 409);
  }
  const message = await sql.prepare(`SELECT m.id,m.content,m.model,m.created_at,c.title,u.input_tokens,u.output_tokens
    FROM messages m JOIN conversations c ON c.id=m.conversation_id
    JOIN usage u ON u.id=m.usage_id AND u.user_id=c.user_id
    WHERE m.id=? AND c.id=? AND c.user_id=? AND m.usage_id=?`)
    .bind(operation.assistant_message_id, operation.conversation_id, owner, operation.id)
    .first<{ id: string; content: string; model: string; created_at: number; title: string; input_tokens: number; output_tokens: number }>();
  if (!message) return json({ error: '이 응답은 이후 수정되었거나 삭제되었습니다. 현재 대화를 다시 불러와주세요.', code: 'REQUEST_SUPERSEDED' }, 409);
  const identity = { conversationId: operation.conversation_id, requestId: operation.id, userMessageId: operation.user_message_id, assistantMessageId: message.id, action: operation.action, replayed: true };
  const events = [
    { type: 'start', ...identity, model: message.model, title: message.title, createdAt: operation.created_at },
    { type: 'delta', text: message.content },
    { type: 'done', ...identity, createdAt: message.created_at, title: message.title, usage: { input: message.input_tokens, output: message.output_tokens } },
  ];
  return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: streamHeaders });
}

async function preparePlan(sql: D1Database, conversationId: string, action: ChatAction, body: Record<string, any>, freshUserId: string, now: number): Promise<GenerationPlan> {
  if (action === 'append') {
    const rows = (await sql.prepare(`SELECT ${turnColumns} FROM messages WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 40`).bind(conversationId).all<StoredTurn>()).results.reverse();
    return { prompt: body.prompt.trim(), history: rows.map(({ role, content }) => ({ role, content })), userMessageId: freshUserId, userCreatedAt: Math.max(now, (rows.at(-1)?.created_at ?? now - 1) + 1) };
  }
  const selected = await sql.prepare(`SELECT ${turnColumns} FROM messages WHERE conversation_id=? AND id=?`).bind(conversationId, body.messageId).first<StoredTurn>();
  if (!selected) reject('수정할 메시지를 찾을 수 없습니다. 대화를 새로 불러와주세요.', 404, 'MESSAGE_NOT_FOUND');
  let user: StoredTurn, archiveFrom: StoredTurn | undefined;
  if (action === 'edit') {
    if (selected.role !== 'user') reject('직접 작성한 질문만 수정할 수 있습니다.');
    user = selected; archiveFrom = selected;
  } else {
    const tail = (await sql.prepare(`SELECT ${turnColumns} FROM messages WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 2`).bind(conversationId).all<StoredTurn>()).results;
    if (tail[0]?.id !== selected.id) reject('가장 최근 응답만 다시 생성할 수 있습니다. 이전 질문은 수정하여 다시 보낼 수 있습니다.', 409, 'STALE_MESSAGE');
    if (selected.role === 'assistant') {
      if (tail[1]?.role !== 'user') reject('응답에 연결된 질문을 찾을 수 없습니다.', 409, 'INVALID_CONVERSATION_STATE');
      user = tail[1]; archiveFrom = selected;
    } else user = selected;
  }
  const rows = (await sql.prepare(`SELECT ${turnColumns} FROM messages WHERE conversation_id=?
    AND (created_at<? OR (created_at=? AND rowid<?)) ORDER BY created_at DESC,rowid DESC LIMIT 40`)
    .bind(conversationId, user.created_at, user.created_at, user.original_order).all<StoredTurn>()).results.reverse();
  const attachmentStart = user.content.search(/\n\n<attached_document\b/);
  const attachments = attachmentStart < 0 ? '' : user.content.slice(attachmentStart);
  return {
    // Regeneration never trusts a client-supplied substitute for the saved prompt.
    prompt: action === 'regenerate' ? user.content : body.prompt.trim() + attachments,
    history: rows.map(({ role, content }) => ({ role, content })), userMessageId: user.id,
    userCreatedAt: action === 'regenerate' ? user.created_at : Math.max(now, (rows.at(-1)?.created_at ?? now - 1) + 1), archiveFrom,
  };
}

function revisionStatements(sql: D1Database, owner: string, operation: ChatOperation, plan: GenerationPlan, now: number): D1PreparedStatement[] {
  if (!plan.archiveFrom) return [];
  const from = plan.archiveFrom, boundary = [from.created_at, from.created_at, from.original_order];
  return [
    sql.prepare('INSERT INTO conversation_revisions (id,conversation_id,user_id,action,target_message_id,created_at) VALUES (?,?,?,?,?,?)')
      .bind(operation.id, operation.conversation_id, owner, operation.action, operation.target_message_id, now),
    sql.prepare(`INSERT INTO conversation_revision_messages (revision_id,message_id,original_order,role,content,model,usage_id,created_at)
      SELECT ?,id,rowid,role,content,model,usage_id,created_at FROM messages WHERE conversation_id=? AND ${fromBoundary}`)
      .bind(operation.id, operation.conversation_id, ...boundary),
    sql.prepare(`DELETE FROM messages WHERE conversation_id=? AND ${fromBoundary}`).bind(operation.conversation_id, ...boundary),
  ];
}

/** The authenticated route owns identity/origin checks; this function owns one billable turn. */
export async function handleChatGeneration(req: Request, sql: D1Database, owner: string, env: Cloudflare.Env, scheduled = false, onWorkComplete?: () => Promise<void>): Promise<Response> {
  if (req.signal.aborted) return json({ error: '요청이 취소되었습니다.' }, 408);
  if (Number(req.headers.get('content-length') || 0) > 100000) return json({ error: 'Request is too large.' }, 413);
  const body = await req.json() as Record<string, any>;
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject('Provide a valid chat request.');
  if (Object.keys(body).some(key => !['model', 'prompt', 'effort', 'pro', 'conversationId', 'fileIds', 'workspaceMode', 'skillId', 'tool', 'researchSources', 'generateTitle', 'action', 'messageId', 'clientRequestId', 'regenerateStyle'].includes(key))) reject('Unknown chat request field.');
  if (body.generateTitle !== undefined && typeof body.generateTitle !== 'boolean') reject('Choose a valid title option.');
  const action: ChatAction = body.action === undefined ? 'append' : body.action;
  if (!['append', 'edit', 'regenerate'].includes(action)) reject('올바른 대화 작업을 선택해주세요.');
  if (body.regenerateStyle !== undefined && (action !== 'regenerate' || !isRegenerateStyle(body.regenerateStyle))) reject('응답 다시 생성 옵션을 확인해주세요.');
  const regenerateStyle = action === 'regenerate' ? body.regenerateStyle ?? 'retry' : undefined;
  const model = findModel(body.model);
  if (!model) reject('Choose a valid model.');
  if (!AVAILABLE_CHAT_MODELS.some(available => available.id === model.id)) reject('이 모델은 현재 새 대화에 사용할 수 없습니다. 사용 가능한 모델을 선택해주세요.', 400, 'MODEL_NOT_AVAILABLE');
  if (action !== 'regenerate' && (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 32000)) reject('Enter a prompt under 32,000 characters.');
  if (body.conversationId !== undefined && !safeId(body.conversationId)) reject('Invalid conversation.');
  if (body.messageId !== undefined && !safeId(body.messageId)) reject('올바른 메시지를 선택해주세요.');
  if (action !== 'append' && (!body.conversationId || !safeId(body.messageId))) reject('수정할 대화와 메시지를 선택해주세요.');
  if (body.clientRequestId !== undefined && (typeof body.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.clientRequestId))) reject('요청 ID가 올바르지 않습니다.');
  if (action !== 'append' && !body.clientRequestId) reject('수정 요청에는 중복 방지용 요청 ID가 필요합니다.');
  if (body.fileIds !== undefined && (!Array.isArray(body.fileIds) || body.fileIds.length > 3 || body.fileIds.some((value: unknown) => !safeId(value)) || new Set(body.fileIds).size !== body.fileIds.length)) reject('Attach at most three valid files.');
  if (action !== 'append' && body.fileIds?.length) reject('기존 질문을 수정할 때는 저장된 첨부 파일을 그대로 사용합니다. 새 파일은 새 메시지에 첨부해주세요.');
  const { tool, researchSources } = validateToolRequest(body, getWorkspaceCapabilities(env));
  if (tool === 'image' || tool === 'video' || tool === 'music') return json({ error: '미디어 생성 화면에서 요청해주세요.', code: 'USE_MEDIA_ENDPOINT' }, 400);
  const webResearch = tool === 'research' && researchSources.web;
  if (webResearch && model.provider !== 'openai') reject('웹 리서치를 사용할 때는 연결된 OpenAI 모델을 선택해주세요.');
  if (body.workspaceMode !== undefined && body.workspaceMode !== 'chat' && body.workspaceMode !== 'work') reject('Choose chat or work mode.');
  if (body.skillId !== undefined && !safeId(body.skillId)) reject('Select a valid saved skill.');
  if (body.pro !== undefined && typeof body.pro !== 'boolean') reject('Choose a valid reasoning mode.');
  if (body.pro && !model.pro) reject('Pro mode is not supported by the selected model.');
  if (body.effort !== undefined && typeof body.effort !== 'string') reject('Choose a valid reasoning level.');
  const effort = body.effort === undefined ? 'medium' : body.effort;
  if (model.efforts.length && !model.efforts.includes(effort)) reject('This reasoning level is not supported by the selected model.');
  const hash = await requestHash({ action, regenerateStyle, conversationId: body.conversationId || null, messageId: action === 'append' ? null : body.messageId,
    prompt: action === 'regenerate' ? null : body.prompt.trim(), model: model.id, effort, pro: !!body.pro, fileIds: body.fileIds || [],
    tool, researchSources, workspaceMode: body.workspaceMode || 'chat', skillId: body.skillId || null, generateTitle: body.generateTitle === true });
  const clientRequestId = body.clientRequestId || uid();
  const existing = await sql.prepare('SELECT * FROM chat_operations WHERE user_id=? AND client_request_id=?').bind(owner, clientRequestId).first<ChatOperation>();
  if (existing) return replayOperation(sql, owner, existing, hash);
  // Access follows the selected model, never the checkout/beta switch. A
  // caller cannot obtain a paid model through a forged selection, scheduled
  // request, comparison, or regeneration while the site is still in beta.
  const free = isFreeModel(model.id);
  if (await sql.prepare('SELECT user_id FROM account_flags WHERE user_id=?').bind(owner).first()) return json({ error: '결제 정산 확인이 필요한 계정입니다.' }, 403);
  if (!free && await balance(sql, owner) <= 0) return json({ error: '이 모델은 유료 크레딧을 충전한 후 사용할 수 있습니다. Gemini 3.5 Flash-Lite는 무료로 사용할 수 있습니다.', code: 'PAID_CREDIT_REQUIRED' }, 402);
  const secret = PROVIDERS[model.provider].secret, key = env[secret as keyof Cloudflare.Env] as string | undefined;
  if (!key) return json({ error: PROVIDERS[model.provider].name + ' is not connected yet. Configure ' + secret + ' as a server secret to enable real responses.', code: 'PROVIDER_NOT_CONFIGURED', provider: model.provider }, 503);
  const billing = free ? undefined : await getBillingConfig(sql), rate = billing?.rates[model.id];
  if (free && !model.betaRate) return json({ error: 'This model does not have a configured free allowance.' }, 503);
  if (!free && !rate) return json({ error: '이 모델의 사용량 차감 단가가 아직 확정되지 않았습니다.', code: 'PRICING_NOT_CONFIGURED' }, 503);
  const conversationId = body.conversationId || uid(), now = Date.now();
  if (body.conversationId && !await sql.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').bind(conversationId, owner).first()) return json({ error: 'Conversation not found.' }, 404);
  const operation: ChatOperation = { id: uid(), user_id: owner, client_request_id: clientRequestId, request_hash: hash, conversation_id: conversationId,
    action, target_message_id: action === 'append' ? null : body.messageId, user_message_id: uid(), assistant_message_id: uid(), status: 'preparing', error: null, created_at: now, updated_at: now };
  const claimed = await sql.prepare(`INSERT INTO chat_operations (id,user_id,client_request_id,request_hash,conversation_id,action,target_message_id,user_message_id,assistant_message_id,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'preparing',?,?) ON CONFLICT(user_id,client_request_id) DO NOTHING RETURNING id`)
    .bind(operation.id, owner, clientRequestId, hash, conversationId, action, operation.target_message_id, operation.user_message_id, operation.assistant_message_id, now, now).first();
  if (!claimed) {
    const concurrent = await sql.prepare('SELECT * FROM chat_operations WHERE user_id=? AND client_request_id=?').bind(owner, clientRequestId).first<ChatOperation>();
    return concurrent ? replayOperation(sql, owner, concurrent, hash) : json({ error: '요청을 확인하지 못했습니다. 다시 시도해주세요.' }, 409);
  }
  const requestId = operation.id, lockKey = 'chat:' + conversationId;
  let reservation = 0, providerStarted = false, lease: RequestLease | null = null;
  try {
    await sql.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(now).run();
    const limit = await sql.prepare('INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(owner + ':' + Math.floor(now / 60000), now + 120000).first<{ count: number }>();
    if (!limit || limit.count > 20) reject('Too many requests. Wait a minute and try again.', 429, 'RATE_LIMITED');
    lease = await acquireRequestLease(sql, lockKey, 250000);
    if (!lease) reject('This conversation already has a response in progress.', 409, 'CONVERSATION_BUSY');
    // A deletion can finish after the first ownership read and before this lock.
    if (body.conversationId && !await sql.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').bind(conversationId, owner).first()) reject('Conversation not found.', 404, 'CONVERSATION_NOT_FOUND');
    const currentChat = body.conversationId ? await sql.prepare('SELECT title FROM conversations WHERE id=? AND user_id=?').bind(conversationId, owner).first<{ title: string }>() : null;
    const plan = await preparePlan(sql, conversationId, action, body, operation.user_message_id, now);
    operation.user_message_id = plan.userMessageId;
    for (const id of body.fileIds || []) {
      const file = await sql.prepare('SELECT name,key FROM files WHERE id=? AND user_id=?').bind(id, owner).first<{ name: string; key: string }>();
      if (!file || !isOwnedObjectKey(file.key, owner)) reject('An attached file is no longer available.');
      const stored = await env.BUCKET?.get(file.key);
      if (!stored || stored.size > MAX_TEXT_FILE_BYTES) reject('An attached file could not be read.');
      plan.prompt += '\n\n<attached_document name=' + JSON.stringify(file.name) + '>\n' + await stored.text() + '\n</attached_document>';
    }
    const codeExecution = body.workspaceMode === 'work' && tool === 'chat' && model.provider === 'openai' && free && env.WORK_CODE_EXECUTION_ENABLED !== 'false';
    // "Without personalization" is request-scoped and does not modify saved
    // settings. It also omits a selected saved skill and Work style preference.
    const sourcePrompt = withUntrustedDocuments(plan.prompt);
    const contextualPrompt = regenerateStyle === 'no_personalization' ? sourcePrompt
      : withWorkspaceContext(sourcePrompt, await getWorkspaceSettings(sql, owner), body.workspaceMode || 'chat', body.skillId);
    const providerPrompt = withRegenerateStyle(withToolContext(contextualPrompt, tool, researchSources), regenerateStyle)
      + (codeExecution ? '\n\nYou may use the supplied code_interpreter tool for Python calculations, analysis, and generating files in an isolated sandbox with network access disabled. Use it only when useful. Report actual execution results only after the tool succeeds. You cannot operate external apps, deploy sites, install software on the user device, or continue running after this response. Keep generated files below 5 MB each and at most three files; the application will preserve them for download.' : '');
    // Re-quote legacy attachments on every turn, including edits/regeneration.
    // Saved source text is never promoted into the trusted instruction channel.
    const providerTurns: Turn[] = [...plan.history.map(turn => ({ role: turn.role, content: withUntrustedDocuments(turn.content) })), { role: 'user', content: providerPrompt }];
    if (providerTurns.reduce((length, turn) => length + turn.content.length, 0) > 240000) reject('This conversation is too long. Start a new chat or use smaller documents.');
    const inputBound = new TextEncoder().encode(providerTurns.map(turn => turn.content).join('')).length + PROVIDER_INPUT_OVERHEAD_BYTES;
    if (free && inputBound > BETA_INPUT_BYTES + PROVIDER_INPUT_OVERHEAD_BYTES) reject('Free conversations support up to 16 KB of total text. Start a new conversation or use a smaller document.');
    if (webResearch && !free) reject('웹 검색이 포함된 요금 설정이 필요합니다.', 503);
    if (req.signal.aborted) reject('요청이 취소되었습니다.', 408);
    const shouldTitle = !body.conversationId && body.generateTitle === true && !scheduled;
    const titleReserve = free && shouldTitle ? Math.ceil(PROVIDER_INPUT_OVERHEAD_BYTES * model.betaRate!.input + 256 * model.betaRate!.output) : 0;
    const toolReserve = (webResearch ? 20000 : 0) + (codeExecution ? 60000 : 0) + titleReserve, reservedInput = inputBound + (webResearch ? 32000 : 0);
    const outputLimit = free ? await betaTextOutput(sql, owner, model, reservedInput, toolReserve, betaDailyLimit(env), model.id !== 'gpt-6.1-sol' || !!body.pro || ['high', 'xhigh', 'max'].includes(effort)) : 8192;
    reservation = free ? await reserveBeta(sql, owner, requestId, reservedInput, now, toolReserve, betaDailyLimit(env), { model, maxOutput: outputLimit }) : cost(rate!, inputBound, outputLimit);
    if (!free) await reserve(sql, owner, requestId, reservation);
    const initialTitle = currentChat?.title || fallbackChatTitle(body.prompt);
    await sql.batch([
      requestLeaseFence(sql,lease),
      ...(!body.conversationId ? [sql.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(conversationId, owner, initialTitle, model.id, now, now)] : []),
      ...(action === 'append' ? [sql.prepare('INSERT INTO messages (id,conversation_id,role,content,model,created_at) VALUES (?,?,?,?,?,?)').bind(plan.userMessageId, conversationId, 'user', plan.prompt, null, plan.userCreatedAt)] : []),
      ...(!free ? [sql.prepare('INSERT INTO usage (id,user_id,model,provider,status,created_at,rate_snapshot,reserved_amount) VALUES (?,?,?,?,?,?,?,?)').bind(requestId, owner, model.id, model.provider, 'pending', now, JSON.stringify(rate), reservation)] : []),
      sql.prepare("UPDATE chat_operations SET user_message_id=?,status='running',updated_at=? WHERE id=? AND user_id=?").bind(plan.userMessageId, now, requestId, owner),
    ]);
    const encoder = new TextEncoder(), aborter = new AbortController();
    let closed = false, timedOut = false, userAborted = false;
    const timer = setTimeout(() => { timedOut = true; aborter.abort(); }, 240000);
    const onAbort = () => { userAborted = true; aborter.abort(); };
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) onAbort();
    const identity = { conversationId, requestId, userMessageId: plan.userMessageId, assistantMessageId: operation.assistant_message_id, action };
    const stream = new ReadableStream({
      async start(controller) {
        let text = '', artifactIds: string[] = [], persisted = false, measured: Usage | undefined;
        const generationStartedAt = Date.now();
        let outcomeStatus = 200;
        const emit = (value: unknown) => { if (!closed) controller.enqueue(encoder.encode('data: ' + JSON.stringify(value) + '\n\n')); };
        try {
          emit({ type: 'start', ...identity, model: model.id, tool, title: initialTitle, createdAt: now, replacesFromMessageId: plan.archiveFrom?.id });
          if (aborter.signal.aborted) throw new DOMException('요청이 취소되었습니다.', 'AbortError');
          if (!await requestLeaseIsCurrent(sql, lease!)) reject('요청의 실행 권한이 만료되었습니다. 다시 시도해주세요.', 409, 'CONVERSATION_LEASE_LOST');
          providerStarted = true;
          const titleTask = shouldTitle ? trackProviderAttempt(sql, requestId, () => generateChatTitle(model, key, body.prompt, aborter.signal)) : undefined;
          measured = await trackProviderAttempt(sql, requestId, () => invokeProvider(model, key, providerTurns, effort, !!body.pro, aborter.signal, delta => { text += delta; emit({ type: 'delta', text: delta }); }, outputLimit, {
            webSearch: webResearch, codeInterpreter: codeExecution, maxToolCalls: 2,
            onTextReplace: value => { text = value; emit({ type: 'replace', text: value }); }, onSources: sources => emit({ type: 'sources', sources }),
          }));
          if (free) {
            const charge = Math.ceil(measured.input * model.betaRate!.input + measured.output * model.betaRate!.output) + titleReserve + (measured.webSearchCalls || 0) * 10000 + (measured.codeInterpreterContainers || 0) * 30000;
            if (charge > reservation) throw new Error('Provider usage exceeded the reserved free allowance.');
            await sql.prepare('UPDATE usage SET reserved_amount=? WHERE id=? AND user_id=?').bind(charge, requestId, owner).run();
          } else await settle(sql, owner, requestId, reservation, cost(rate!, measured.input, measured.output));
          if (aborter.signal.aborted) throw new DOMException('요청이 취소되었습니다.', 'AbortError');
          if (!await requestLeaseIsCurrent(sql, lease!)) reject('요청의 실행 권한이 만료되었습니다. 대화를 다시 불러와주세요.', 409, 'CONVERSATION_LEASE_LOST');
          if (measured.artifacts?.length) {
            try {
              const artifacts = await storeWorkArtifacts(env, sql, owner, conversationId, measured.artifacts, aborter.signal);
              artifactIds = artifacts.map(file => file.id);
              text += '\n\n생성한 파일\n' + artifacts.map(file => `- [${file.name.replace(/[\[\]\\]/g, ' ')}](${file.url})`).join('\n');
            } catch { text += '\n\n생성 파일을 저장하지 못했습니다. 필요한 내용을 대화에 직접 표시하도록 다시 요청해주세요.'; }
            emit({ type: 'replace', text });
          }
          if (!text.trim()) throw new Error('The provider returned no text.');
          if (aborter.signal.aborted) throw new DOMException('요청이 취소되었습니다.', 'AbortError');
          const ended = Date.now(), assistantCreatedAt = Math.max(ended, plan.userCreatedAt + 1);
          await sql.batch([
            requestLeaseFence(sql,lease!),
            ...revisionStatements(sql, owner, operation, plan, ended),
            ...(action === 'edit' ? [sql.prepare('INSERT INTO messages (id,conversation_id,role,content,model,created_at) VALUES (?,?,?,?,?,?)').bind(plan.userMessageId, conversationId, 'user', plan.prompt, null, plan.userCreatedAt)] : []),
            sql.prepare('INSERT INTO messages (id,conversation_id,role,content,model,created_at,usage_id) VALUES (?,?,?,?,?,?,?)').bind(operation.assistant_message_id, conversationId, 'assistant', text, model.id, assistantCreatedAt, requestId),
            sql.prepare("UPDATE usage SET input_tokens=?,output_tokens=?,status='complete',duration=? WHERE id=? AND user_id=?").bind(measured.input, measured.output, Math.max(0, ended - now), requestId, owner),
            sql.prepare('UPDATE conversations SET updated_at=?,model=? WHERE id=? AND user_id=?').bind(assistantCreatedAt, model.id, conversationId, owner),
            sql.prepare("UPDATE chat_operations SET status='complete',updated_at=? WHERE id=? AND user_id=?").bind(ended, requestId, owner),
          ]);
          persisted = true;
          let title: string | undefined;
          if (titleTask && !aborter.signal.aborted) {
            title = await titleTask;
            if (title) try {
              const result = await sql.prepare('UPDATE conversations SET title=? WHERE id=? AND user_id=? AND title=? AND updated_at=? AND EXISTS (SELECT 1 FROM rate_limits WHERE key=? AND lease_token=? AND expires_at>?)').bind(title, conversationId, owner, initialTitle, assistantCreatedAt, lease!.key, lease!.token, Date.now()).run();
              if (!result.meta.changes) title = undefined;
            } catch { title = undefined; }
          }
          emit({ type: 'done', ...identity, createdAt: assistantCreatedAt, title, revisionId: plan.archiveFrom ? requestId : undefined,
            usage: { input: measured.input, output: measured.output, webSearchCalls: measured.webSearchCalls, codeInterpreterContainers: measured.codeInterpreterContainers }, tool });
        } catch (failure) {
          if (persisted) return;
          outcomeStatus = userAborted ? 499 : timedOut || failure instanceof Error && failure.name === 'TimeoutError' ? 504
            : failure instanceof BillingError || failure instanceof WorkspaceToolError ? failure.status : 500;
          if (artifactIds.length) try { await deleteWorkArtifacts(env, sql, owner, artifactIds); } catch { console.error(JSON.stringify({ event: 'artifact_cleanup_failed', requestId })); }
          if (!providerStarted && !free) await settle(sql, owner, requestId, reservation, 0);
          const message = publicChatError(failure)
            + (providerStarted ? (free ? ' 접수된 요청은 무료 이용 한도에 포함됩니다.' : measured ? '완료된 제공사 사용량은 요금에 반영됩니다.' : ' 사용량이 확정되지 않은 요청의 예약금은 정산 확인까지 보류됩니다.') : ' AI 요청을 보내지 않았습니다.');
          try {
            await sql.batch([
              sql.prepare("UPDATE usage SET status='error',error=?,duration=?,input_tokens=?,output_tokens=?,reserved_amount=CASE WHEN ? THEN 0 ELSE reserved_amount END WHERE id=? AND user_id=?")
                .bind(message, Math.max(0, Date.now() - now), measured?.input || 0, measured?.output || 0, Number(!providerStarted && free), requestId, owner),
              sql.prepare("UPDATE chat_operations SET status='error',error=?,updated_at=? WHERE id=? AND user_id=?").bind(message, Date.now(), requestId, owner),
            ]);
          } catch { console.error(JSON.stringify({ event: 'chat_error_record_failed', requestId })); }
          try { emit({ type: 'error', error: message, ...identity }); } catch { /* The consumer may already have cancelled. */ }
        } finally {
          clearTimeout(timer); req.signal.removeEventListener('abort', onAbort);
          await recordGenerationOutcome(sql, { route: '/api/chat', requestId, status: outcomeStatus, startedAt: generationStartedAt });
          try { await releaseRequestLease(sql, lease!); }
          catch { console.error(JSON.stringify({ event: 'chat_lock_release_failed', requestId })); }
          try { await onWorkComplete?.(); } catch { console.error(JSON.stringify({ event: 'account_operation_release_failed', requestId })); }
          if (!closed) { closed = true; try { controller.close(); } catch { /* Already cancelled. */ } }
        }
      },
      cancel() { closed = true; onAbort(); },
    });
    const response = new Response(stream, { headers: streamHeaders });
    backgroundResponses.add(response);
    return response;
  } catch (failure) {
    if (reservation && !providerStarted) {
      if (free) await sql.prepare("UPDATE usage SET status='error',error='Request preparation failed',reserved_amount=0 WHERE id=? AND user_id=?").bind(requestId, owner).run();
      else await settle(sql, owner, requestId, reservation, 0);
    }
    await sql.prepare("UPDATE chat_operations SET status='error',error=?,updated_at=? WHERE id=? AND user_id=?").bind(publicChatError(failure), Date.now(), requestId, owner).run();
    if (lease) await releaseRequestLease(sql, lease);
    return json({ error: publicChatError(failure), ...((failure instanceof BillingError || failure instanceof WorkspaceToolError) ? { code: failure.code } : {}) }, failure instanceof BillingError || failure instanceof WorkspaceToolError ? failure.status : 500);
  }
}
