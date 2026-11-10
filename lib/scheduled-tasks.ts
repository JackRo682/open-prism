import { findOwnedResource } from './authorization';
import { findModel } from './models';
import { isTimeZone, nextScheduledAt, type ScheduleRecurrence } from './schedule-time';

export type ScheduledTask = {
  id: string; title: string; prompt: string; model: string; timezone: string;
  recurrence: ScheduleRecurrence; scheduled_at: number; next_run: number | null;
  last_run: number | null; last_error: string | null; last_conversation_id: string | null;
  enabled: boolean; status: 'draft' | 'active' | 'paused' | 'running' | 'completed' | 'error';
  running_until: number | null; created_at: number; updated_at: number;
};
type StoredTask = Omit<ScheduledTask, 'enabled' | 'running_until'> & { user_id: string; enabled: number; run_token: string | null; locked_until: number | null };
export type ScheduledTaskResult = { conversationId: string };
export type ScheduledTaskExecutor = (task: ScheduledTask, request: Request, owner: string) => Promise<ScheduledTaskResult>;
type TaskOptions = { runnerReady?: boolean; now?: () => number };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const MAX_TASKS = 30, LEASE_MS = 300_000;
const editableKeys = new Set(['title', 'prompt', 'model', 'timezone', 'recurrence', 'scheduledAt', 'enabled']);

export class ScheduledTaskError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'INVALID_TASK') { super(message); this.name = 'ScheduledTaskError'; }
}

function publicTask(task: StoredTask): ScheduledTask {
  const { user_id: _owner, run_token: _token, locked_until: _lock, enabled, ...fields } = task;
  return { ...fields, enabled: enabled === 1, running_until: _lock };
}

async function ownedTask(sql: D1Database, owner: string, id: string) {
  const task = await findOwnedResource<StoredTask>(sql, 'task', id, owner);
  if (!task) throw new ScheduledTaskError('예약된 작업을 찾을 수 없습니다.', 404, 'TASK_NOT_FOUND');
  return task;
}

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try { body = await req.json(); } catch { throw new ScheduledTaskError('올바른 작업 정보를 입력해 주세요.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !editableKeys.has(key))) {
    throw new ScheduledTaskError('변경할 수 없는 작업 정보가 포함되어 있습니다.');
  }
  return body as Record<string, unknown>;
}

function validateTask(body: Record<string, unknown>, existing: StoredTask | null, now: number, runnerReady: boolean) {
  const pick = (key: string, fallback: unknown) => Object.hasOwn(body, key) ? body[key] : fallback;
  const title = pick('title', existing?.title), prompt = pick('prompt', existing?.prompt);
  const model = pick('model', existing?.model ?? 'gpt-6.1-sol');
  const timezone = pick('timezone', existing?.timezone);
  const recurrence = pick('recurrence', existing?.recurrence ?? 'once');
  const scheduledAt = pick('scheduledAt', existing?.scheduled_at);
  const enabled = pick('enabled', existing?.enabled === 1);
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 100) throw new ScheduledTaskError('작업 이름은 1~100자로 입력해 주세요.');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8_000) throw new ScheduledTaskError('작업 내용은 1~8,000자로 입력해 주세요.');
  if (typeof model !== 'string' || !findModel(model)) throw new ScheduledTaskError('지원되는 AI 모델을 선택해 주세요.');
  if (!isTimeZone(timezone)) throw new ScheduledTaskError('올바른 시간대를 입력해 주세요. 예: Asia/Seoul');
  if (recurrence !== 'once' && recurrence !== 'daily' && recurrence !== 'weekly') throw new ScheduledTaskError('한 번, 매일, 매주 중 하나를 선택해 주세요.');
  if (typeof scheduledAt !== 'number' || !Number.isSafeInteger(scheduledAt) || scheduledAt <= 0 || scheduledAt > now + 5 * 366 * 86_400_000) {
    throw new ScheduledTaskError('5년 이내의 올바른 실행 시각을 선택해 주세요.');
  }
  if ((!existing || Object.hasOwn(body, 'scheduledAt')) && scheduledAt <= now) throw new ScheduledTaskError('실행 시각은 현재보다 나중이어야 합니다.');
  if (typeof enabled !== 'boolean') throw new ScheduledTaskError('자동 실행 설정을 확인해 주세요.');
  if (enabled && !runnerReady && (!existing?.enabled || Object.hasOwn(body, 'enabled'))) {
    throw new ScheduledTaskError('자동 실행 서비스 연결이 필요합니다. 초안으로 저장하거나 지금 실행해 주세요.', 503, 'SCHEDULE_RUNNER_NOT_CONFIGURED');
  }
  const changedTime = !existing || ['scheduledAt', 'timezone', 'recurrence'].some(key => Object.hasOwn(body, key));
  let nextRun = changedTime ? scheduledAt : existing.next_run;
  if (enabled && (changedTime || !existing?.enabled)) {
    nextRun = nextScheduledAt(scheduledAt, recurrence, timezone, now);
    if (nextRun === null) throw new ScheduledTaskError('실행 시각이 지난 작업입니다. 새 실행 시각을 선택해 주세요.');
  }
  const status: ScheduledTask['status'] = enabled ? 'active' : existing && (existing.enabled || existing.status !== 'draft') ? 'paused' : 'draft';
  return { title: title.trim(), prompt: prompt.trim(), model, timezone, recurrence, scheduledAt, nextRun, enabled, status };
}

/** Execute only after the caller has established visitor or runner authority. */
export async function executeScheduledTask(
  sql: D1Database, owner: string, id: string, req: Request, execute: ScheduledTaskExecutor,
  options: { scheduled?: boolean; now?: () => number } = {},
): Promise<{ task: ScheduledTask; conversationId: string }> {
  if (req.signal.aborted) throw new ScheduledTaskError('작업 실행 요청이 취소되었습니다.', 408, 'TASK_CANCELLED');
  const now = options.now ?? Date.now, started = now(), existing = await ownedTask(sql, owner, id);
  if (options.scheduled && (!existing.enabled || existing.next_run === null || existing.next_run > started)) {
    throw new ScheduledTaskError('아직 실행할 시간이 되지 않았거나 일시정지된 작업입니다.', 409, 'TASK_NOT_DUE');
  }
  if (existing.run_token && (existing.locked_until ?? 0) > started) throw new ScheduledTaskError('이 작업이 이미 실행 중입니다.', 409, 'TASK_RUNNING');
  // An automatic runner must not replay an uncertain, possibly billed request.
  // Mark a stale lease and advance; a visitor can explicitly choose Run now.
  if (options.scheduled && existing.run_token) {
    const next = nextScheduledAt(existing.scheduled_at, existing.recurrence, existing.timezone, started);
    const message = '이전 실행의 완료 여부를 확인하지 못했습니다. 중복 실행을 피하기 위해 자동 재시도를 건너뛰었습니다.';
    await sql.prepare("UPDATE scheduled_tasks SET status='error',last_error=?,next_run=?,enabled=?,run_token=NULL,locked_until=NULL,updated_at=? WHERE id=? AND user_id=? AND run_token=?")
      .bind(message, next, next === null ? 0 : existing.enabled, started, id, owner, existing.run_token).run();
    throw new ScheduledTaskError(message, 409, 'TASK_PREVIOUS_RUN_UNCERTAIN');
  }
  const token = crypto.randomUUID();
  const claimed = await sql.prepare(`UPDATE scheduled_tasks SET status='running',run_token=?,locked_until=?,updated_at=? WHERE id=? AND user_id=? AND (run_token IS NULL OR locked_until<=?)${options.scheduled ? ' AND enabled=1 AND next_run IS NOT NULL AND next_run<=?' : ''} RETURNING *`)
    .bind(token, started + LEASE_MS, started, id, owner, started, ...(options.scheduled ? [started] : [])).first<StoredTask>();
  if (!claimed) throw new ScheduledTaskError('이 작업이 이미 실행 중이거나 변경되었습니다.', 409, 'TASK_RUNNING');
  // A disconnect during the database awaits must not start provider work or
  // consume a scheduled occurrence. No external side effect has begun yet.
  if (req.signal.aborted) {
    await sql.prepare('UPDATE scheduled_tasks SET status=?,run_token=NULL,locked_until=NULL,updated_at=? WHERE id=? AND user_id=? AND run_token=?')
      .bind(existing.status, now(), id, owner, token).run();
    throw new ScheduledTaskError('작업 실행 요청이 취소되었습니다.', 408, 'TASK_CANCELLED');
  }
  try {
    const result = await execute(publicTask(claimed), req, owner);
    if (!result || typeof result.conversationId !== 'string' || !result.conversationId || result.conversationId.length > 100) {
      throw new ScheduledTaskError('작업 결과를 저장했는지 확인하지 못했습니다.', 502, 'TASK_RESULT_MISSING');
    }
    const ended = now();
    const next = options.scheduled ? nextScheduledAt(claimed.scheduled_at, claimed.recurrence, claimed.timezone, ended) : claimed.next_run;
    const enabled = options.scheduled && next === null ? 0 : claimed.enabled;
    const status = options.scheduled && next === null ? 'completed' : enabled ? 'active' : existing.status === 'draft' ? 'draft' : 'paused';
    const saved = await sql.prepare('UPDATE scheduled_tasks SET last_run=?,last_error=NULL,last_conversation_id=?,next_run=?,enabled=?,status=?,run_token=NULL,locked_until=NULL,updated_at=? WHERE id=? AND user_id=? AND run_token=? RETURNING *')
      .bind(ended, result.conversationId, next, enabled, status, ended, id, owner, token).first<StoredTask>();
    if (!saved) throw new ScheduledTaskError('실행 상태가 변경되어 결과 연결을 확인하지 못했습니다. 대화 기록을 확인해 주세요.', 409, 'TASK_LEASE_LOST');
    return { task: publicTask(saved), conversationId: result.conversationId };
  } catch (cause) {
    const ended = now(), message = (cause instanceof Error ? cause.message : '작업을 실행하지 못했습니다.').slice(0, 500);
    const next = options.scheduled ? nextScheduledAt(claimed.scheduled_at, claimed.recurrence, claimed.timezone, ended) : claimed.next_run;
    await sql.prepare("UPDATE scheduled_tasks SET last_run=?,last_error=?,next_run=?,enabled=?,status='error',run_token=NULL,locked_until=NULL,updated_at=? WHERE id=? AND user_id=? AND run_token=?")
      .bind(ended, message, next, options.scheduled && next === null ? 0 : claimed.enabled, ended, id, owner, token).run();
    throw cause instanceof ScheduledTaskError ? cause : new ScheduledTaskError(message, 502, 'TASK_EXECUTION_FAILED');
  }
}

/** The root cron endpoint authenticates its server credential before calling. */
export async function runDueScheduledTasks(sql: D1Database, req: Request, execute: ScheduledTaskExecutor, options: { limit?: number; now?: () => number } = {}) {
  const now = options.now ?? Date.now, limit = Math.max(1, Math.min(3, Math.floor(options.limit || 3)));
  const due = (await sql.prepare('SELECT id,user_id FROM scheduled_tasks WHERE enabled=1 AND next_run IS NOT NULL AND next_run<=? AND (run_token IS NULL OR locked_until<=?) ORDER BY next_run,id LIMIT ?')
    .bind(now(), now(), limit).all<{ id: string; user_id: string }>()).results;
  const results: Array<{ id: string; status: 'completed' | 'error' | 'skipped'; conversationId?: string; error?: string }> = [];
  // Sequential execution keeps provider and beta concurrency bounded.
  for (const task of due) {
    if (req.signal.aborted) break;
    try {
      const result = await executeScheduledTask(sql, task.user_id, task.id, req, execute, { scheduled: true, now });
      results.push({ id: task.id, status: 'completed', conversationId: result.conversationId });
    } catch (cause) {
      results.push({ id: task.id, status: cause instanceof ScheduledTaskError && cause.status === 409 ? 'skipped' : 'error', error: (cause instanceof Error ? cause.message : '작업 실행 실패').slice(0, 500) });
    }
  }
  return { attempted: results.length, completed: results.filter(item => item.status === 'completed').length, failed: results.filter(item => item.status === 'error').length, results };
}

export async function handleScheduledTasks(req: Request, path: string[], sql: D1Database, owner: string, execute: ScheduledTaskExecutor, options: TaskOptions = {}): Promise<Response | null> {
  if (path[0] !== 'tasks') return null;
  const now = options.now ?? Date.now, runnerReady = options.runnerReady === true;
  if (!owner) return json({ error: '예약된 작업을 사용하려면 로그인해 주세요.' }, 401);
  const origin = req.headers.get('origin');
  if (req.method !== 'GET' && origin && origin !== new URL(req.url).origin) return json({ error: '허용되지 않은 요청입니다.' }, 403);
  try {
    if (path.length === 1 && req.method === 'GET') {
      const tasks = (await sql.prepare('SELECT * FROM scheduled_tasks WHERE user_id=? ORDER BY created_at DESC,id LIMIT 30').bind(owner).all<StoredTask>()).results;
      return json({ tasks: tasks.map(publicTask), runnerReady });
    }
    if (path.length === 1 && req.method === 'POST') {
      const value = validateTask(await bodyOf(req), null, now(), runnerReady), id = crypto.randomUUID(), created = now();
      const task = await sql.prepare('INSERT INTO scheduled_tasks (id,user_id,title,prompt,model,timezone,recurrence,scheduled_at,next_run,enabled,status,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM scheduled_tasks WHERE user_id=?)<? RETURNING *')
        .bind(id, owner, value.title, value.prompt, value.model, value.timezone, value.recurrence, value.scheduledAt, value.nextRun, Number(value.enabled), value.status, created, created, owner, MAX_TASKS).first<StoredTask>();
      if (!task) throw new ScheduledTaskError('작업은 최대 30개까지 저장할 수 있습니다. 사용하지 않는 작업을 삭제해 주세요.', 409, 'TASK_LIMIT_REACHED');
      return json({ task: publicTask(task), runnerReady }, 201);
    }
    const id = path[1];
    if (!id || !/^[\w-]{1,100}$/.test(id) || path.length > 3) return json({ error: '예약된 작업을 찾을 수 없습니다.' }, 404);
    if (path.length === 3 && path[2] === 'run' && req.method === 'POST') return json(await executeScheduledTask(sql, owner, id, req, execute, { now }));
    if (path.length !== 2) return json({ error: '요청한 작업을 찾을 수 없습니다.' }, 404);
    const existing = await ownedTask(sql, owner, id);
    if (req.method === 'GET') return json({ task: publicTask(existing), runnerReady });
    if (req.method === 'PATCH') {
      const value = validateTask(await bodyOf(req), existing, now(), runnerReady), changed = now();
      const task = await sql.prepare('UPDATE scheduled_tasks SET title=?,prompt=?,model=?,timezone=?,recurrence=?,scheduled_at=?,next_run=?,enabled=?,status=?,run_token=NULL,locked_until=NULL,updated_at=? WHERE id=? AND user_id=? AND (run_token IS NULL OR locked_until<=?) RETURNING *')
        .bind(value.title, value.prompt, value.model, value.timezone, value.recurrence, value.scheduledAt, value.nextRun, Number(value.enabled), value.status, changed, id, owner, changed).first<StoredTask>();
      if (!task) throw new ScheduledTaskError('실행이 끝난 뒤 작업을 수정해 주세요.', 409, 'TASK_RUNNING');
      return json({ task: publicTask(task), runnerReady });
    }
    if (req.method === 'DELETE') {
      const deleted = await sql.prepare('DELETE FROM scheduled_tasks WHERE id=? AND user_id=? AND (run_token IS NULL OR locked_until<=?) RETURNING id').bind(id, owner, now()).first();
      if (!deleted) throw new ScheduledTaskError('실행이 끝난 뒤 작업을 삭제해 주세요.', 409, 'TASK_RUNNING');
      return json({ ok: true });
    }
    return json({ error: '지원하지 않는 요청입니다.' }, 405);
  } catch (cause) {
    if (cause instanceof ScheduledTaskError) return json({ error: cause.message, code: cause.code }, cause.status);
    throw cause;
  }
}
