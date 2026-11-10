import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const runtime = new URL('../.sites-runtime/scheduled-task-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
for (const name of ['authorization', 'models', 'schedule-time', 'scheduled-tasks']) {
  const source = (await readFile(new URL('../lib/' + name + '.ts', import.meta.url), 'utf8'))
    .replaceAll("'./authorization'", "'./authorization.mjs'").replaceAll("'./models'", "'./models.mjs'").replaceAll("'./schedule-time'", "'./schedule-time.mjs'");
  await writeFile(new URL(name + '.mjs', runtime), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const { handleScheduledTasks, executeScheduledTask, runDueScheduledTasks } = await import(new URL('scheduled-tasks.mjs', runtime));
const { parseScheduleDateTime, formatScheduleDateTime, nextScheduledAt } = await import(new URL('schedule-time.mjs', runtime));
const schema = await readFile(new URL('../drizzle/0004_workspace_features.sql', import.meta.url), 'utf8');

function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(schema);
  let clock = Date.parse('2027-01-05T00:00:00Z');
  const now = () => clock;
  const sql = { prepare(query) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return db.prepare(query).get(...values) ?? null; },
      async all() { return { results: db.prepare(query).all(...values) }; },
      async run() { return { success: true, meta: db.prepare(query).run(...values) }; },
    };
  } };
  const execute = async () => ({ conversationId: 'saved-conversation' });
  const request = (path, method = 'GET', body, origin = 'https://prism.test') => new Request('https://prism.test/api/' + path, {
    method, headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const call = (path, method = 'GET', body, { owner = 'alice', runnerReady = false, executor = execute, origin } = {}) =>
    handleScheduledTasks(request(path, method, body, origin), path.split('/'), sql, owner, executor, { runnerReady, now });
  const payload = (overrides = {}) => ({ title: 'Read the saved briefing', prompt: 'Summarize my notes in three points.', timezone: 'Asia/Seoul', recurrence: 'once', scheduledAt: now() + 60_000, ...overrides });
  const create = async (overrides = {}, options = {}) => {
    const response = await call('tasks', 'POST', payload(overrides), options);
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    return (await response.json()).task;
  };
  return { db, sql, now, request, call, payload, create, execute, advance: ms => { clock += ms; }, close: () => db.close() };
}

test('task helper rejects anonymous and cross-origin requests and ignores unrelated paths', async () => {
  const f = fixture();
  try {
    assert.equal((await f.call('tasks', 'GET', undefined, { owner: '' })).status, 401);
    assert.equal((await f.call('tasks', 'POST', f.payload(), { origin: 'https://other.test' })).status, 403);
    assert.equal(await f.call('elsewhere'), null);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scheduled_tasks').get().n, 0);
  } finally { f.close(); }
});

test('missing runner permits useful saved drafts but never claims automatic execution', async () => {
  const f = fixture();
  try {
    const task = await f.create();
    assert.equal(task.enabled, false); assert.equal(task.status, 'draft');
    const listing = await (await f.call('tasks')).json();
    assert.equal(listing.runnerReady, false); assert.equal(listing.tasks.length, 1);
    for (const key of ['user_id', 'run_token', 'locked_until']) assert.equal(key in listing.tasks[0], false);
    assert.equal((await f.call('tasks', 'POST', f.payload({ enabled: true }))).status, 503);
    assert.equal((await f.call('tasks/' + task.id, 'PATCH', { enabled: true })).status, 503);
    assert.equal(f.db.prepare('SELECT enabled FROM scheduled_tasks WHERE id=?').get(task.id).enabled, 0);
  } finally { f.close(); }
});

test('task validation rejects malformed fields and privilege injection without writing records', async () => {
  const f = fixture();
  try {
    for (const patch of [
      { title: '' }, { prompt: 'a'.repeat(8001) }, { model: 'invented-model' }, { timezone: 'not/a/zone' },
      { recurrence: 'hourly' }, { scheduledAt: f.now() }, { scheduledAt: 'tomorrow' },
      { enabled: 'true' }, { enabled: null }, { recurrence: null }, { user_id: 'bob' }, { status: 'completed' },
      { scheduledAt: f.now() + 10 * 365 * 86_400_000 },
    ]) assert.equal((await f.call('tasks', 'POST', f.payload(patch))).status, 400, JSON.stringify(patch));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scheduled_tasks').get().n, 0);
    const task = await f.create();
    for (const patch of [{ enabled: null }, { title: null }, { timezone: null }, { model: null }]) {
      assert.equal((await f.call('tasks/' + task.id, 'PATCH', patch)).status, 400);
    }
  } finally { f.close(); }
});

test('every task action is isolated by owner', async () => {
  const f = fixture(); let executions = 0;
  try {
    const task = await f.create();
    for (const [path, method, body] of [
      ['tasks/' + task.id, 'GET'], ['tasks/' + task.id, 'PATCH', { title: 'Stolen' }],
      ['tasks/' + task.id, 'DELETE'], ['tasks/' + task.id + '/run', 'POST'],
    ]) assert.equal((await f.call(path, method, body, { owner: 'bob', executor: async () => { executions++; return { conversationId: 'bad' }; } })).status, 404);
    assert.deepEqual((await (await f.call('tasks', 'GET', undefined, { owner: 'bob' })).json()).tasks, []);
    assert.equal(executions, 0);
    assert.equal((await (await f.call('tasks/' + task.id)).json()).task.title, task.title);
  } finally { f.close(); }
});

test('edits and deletes persist, and active task count is capped atomically', async () => {
  const f = fixture();
  try {
    const task = await f.create();
    const response = await f.call('tasks/' + task.id, 'PATCH', { title: 'Updated', recurrence: 'daily', timezone: 'UTC', scheduledAt: f.now() + 120_000 });
    assert.equal(response.status, 200);
    const updated = (await response.json()).task;
    assert.equal(updated.title, 'Updated'); assert.equal(updated.recurrence, 'daily'); assert.equal(updated.timezone, 'UTC');
    for (let index = 1; index < 30; index++) await f.create({ title: 'Task ' + index });
    assert.equal((await f.call('tasks', 'POST', f.payload())).status, 409);
    assert.equal((await f.call('tasks/' + task.id, 'DELETE')).status, 200);
    assert.equal((await f.call('tasks/' + task.id)).status, 404);
    await f.create();
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scheduled_tasks').get().n, 30);
  } finally { f.close(); }
});

test('manual execution uses the real executor contract and saves only its completed conversation', async () => {
  const f = fixture();
  try {
    const task = await f.create({ recurrence: 'daily' });
    const response = await f.call('tasks/' + task.id + '/run', 'POST', undefined, { executor: async (received, req, owner) => {
      assert.equal(received.prompt, task.prompt); assert.equal(received.model, 'gpt-6.1-sol'); assert.equal(owner, 'alice');
      assert.equal(req.method, 'POST'); assert.equal(received.status, 'running');
      f.advance(250); return { conversationId: 'actual-saved-id' };
    } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.conversationId, 'actual-saved-id'); assert.equal(result.task.last_conversation_id, 'actual-saved-id');
    assert.equal(result.task.last_run, f.now()); assert.equal(result.task.enabled, false); assert.equal(result.task.status, 'draft');
    assert.equal(result.task.next_run, task.next_run); assert.equal(result.task.running_until, null);
  } finally { f.close(); }
});

test('overlapping execution and writes are blocked while one task is running', async () => {
  const f = fixture(); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), completion = new Promise(resolve => { release = resolve; });
  try {
    const task = await f.create();
    const first = f.call('tasks/' + task.id + '/run', 'POST', undefined, { executor: async () => { entered(); await completion; return { conversationId: 'single-run' }; } });
    await started;
    assert.equal((await f.call('tasks/' + task.id + '/run', 'POST')).status, 409);
    assert.equal((await f.call('tasks/' + task.id, 'PATCH', { title: 'Raced' })).status, 409);
    assert.equal((await f.call('tasks/' + task.id, 'DELETE')).status, 409);
    release(); assert.equal((await first).status, 200);
    assert.equal((await (await f.call('tasks/' + task.id)).json()).task.title, task.title);
  } finally { release?.(); f.close(); }
});

test('provider failure and missing result remain errors without fabricated completion', async () => {
  const f = fixture();
  try {
    for (const executor of [async () => { throw new Error('사용량 한도에 도달했습니다.'); }, async () => ({})]) {
      const task = await f.create();
      const response = await f.call('tasks/' + task.id + '/run', 'POST', undefined, { executor });
      assert.equal(response.status, 502);
      const saved = (await (await f.call('tasks/' + task.id)).json()).task;
      assert.equal(saved.status, 'error'); assert.ok(saved.last_error); assert.equal(saved.last_conversation_id, null); assert.equal(saved.running_until, null);
    }
  } finally { f.close(); }
});

test('cancellation before or during lease acquisition never starts provider work or consumes the schedule', async () => {
  const f = fixture(); let executions = 0;
  try {
    const task = await f.create({ enabled: true }, { runnerReady: true }); f.advance(120_000);
    const first = new AbortController(); first.abort();
    const request = controller => new Request(f.request('tasks/' + task.id + '/run', 'POST'), { signal: controller.signal });
    const executor = async () => { executions++; return { conversationId: 'should-not-run' }; };
    await assert.rejects(() => executeScheduledTask(f.sql, 'alice', task.id, request(first), executor, { now: f.now, scheduled: true }), { code: 'TASK_CANCELLED' });
    const second = new AbortController();
    const sql = { prepare(query) {
      const statement = f.sql.prepare(query);
      if (query.startsWith("UPDATE scheduled_tasks SET status='running'")) {
        const original = statement.first.bind(statement);
        statement.first = async () => { const result = await original(); second.abort(); return result; };
      }
      return statement;
    } };
    await assert.rejects(() => executeScheduledTask(sql, 'alice', task.id, request(second), executor, { now: f.now, scheduled: true }), { code: 'TASK_CANCELLED' });
    const saved = (await (await f.call('tasks/' + task.id)).json()).task;
    assert.equal(executions, 0); assert.equal(saved.status, 'active'); assert.equal(saved.next_run, task.next_run);
    assert.equal(saved.enabled, true); assert.equal(saved.last_run, null); assert.equal(saved.running_until, null);
  } finally { f.close(); }
});

test('due runner advances recurring work, completes one-time work, and retries no completed occurrence', async () => {
  const f = fixture(); let executions = 0;
  try {
    const once = await f.create({ enabled: true }, { runnerReady: true });
    const daily = await f.create({ title: 'Daily', recurrence: 'daily', enabled: true }, { runnerReady: true });
    f.advance(120_000);
    const executor = async (_task, _req, owner) => { assert.equal(owner, 'alice'); executions++; return { conversationId: 'generated-' + executions }; };
    const result = await runDueScheduledTasks(f.sql, f.request('tasks/cron', 'POST'), executor, { now: f.now });
    assert.equal(result.completed, 2); assert.equal(executions, 2);
    const a = (await (await f.call('tasks/' + once.id)).json()).task, b = (await (await f.call('tasks/' + daily.id)).json()).task;
    assert.equal(a.enabled, false); assert.equal(a.next_run, null); assert.equal(a.status, 'completed');
    assert.equal(b.enabled, true); assert.equal(b.next_run, daily.next_run + 86_400_000);
    assert.equal((await runDueScheduledTasks(f.sql, f.request('tasks/cron', 'POST'), executor, { now: f.now })).attempted, 0);
    assert.equal(executions, 2);
  } finally { f.close(); }
});

test('parallel cron deliveries claim a due occurrence at most once', async () => {
  const f = fixture(); let executions = 0;
  try {
    await f.create({ enabled: true }, { runnerReady: true }); f.advance(120_000);
    const executor = async () => { executions++; return { conversationId: 'one-execution' }; };
    const results = await Promise.all([1, 2].map(() => runDueScheduledTasks(f.sql, f.request('tasks/cron', 'POST'), executor, { now: f.now })));
    assert.equal(executions, 1); assert.equal(results.reduce((sum, value) => sum + value.completed, 0), 1);
  } finally { f.close(); }
});

test('cron batches are capped at three and failed recurring occurrences advance without retry storms', async () => {
  const f = fixture(); let executions = 0;
  try {
    for (let i = 0; i < 5; i++) await f.create({ title: 'Daily ' + i, recurrence: 'daily', enabled: true }, { runnerReady: true });
    f.advance(120_000);
    const executor = async () => { executions++; throw new Error('Provider unavailable'); };
    const first = await runDueScheduledTasks(f.sql, f.request('tasks/cron', 'POST'), executor, { now: f.now, limit: 100 });
    assert.equal(first.attempted, 3); assert.equal(first.failed, 3); assert.equal(executions, 3);
    const second = await runDueScheduledTasks(f.sql, f.request('tasks/cron', 'POST'), executor, { now: f.now });
    assert.equal(second.attempted, 2); assert.equal(executions, 5);
    assert.equal((await runDueScheduledTasks(f.sql, f.request('tasks/cron', 'POST'), executor, { now: f.now })).attempted, 0);
  } finally { f.close(); }
});

test('expired automatic leases are marked uncertain instead of silently repeating possibly billed work', async () => {
  const f = fixture(); let executions = 0;
  try {
    const task = await f.create({ recurrence: 'daily', enabled: true }, { runnerReady: true }); f.advance(120_000);
    f.db.prepare("UPDATE scheduled_tasks SET status='running',run_token='stale-token',locked_until=? WHERE id=?").run(f.now() - 1, task.id);
    const executor = async () => { executions++; return { conversationId: 'explicit-retry' }; };
    const result = await runDueScheduledTasks(f.sql, f.request('tasks/cron', 'POST'), executor, { now: f.now });
    assert.equal(executions, 0); assert.equal(result.results[0].status, 'skipped');
    const saved = (await (await f.call('tasks/' + task.id)).json()).task;
    assert.equal(saved.status, 'error'); assert.match(saved.last_error, /중복/); assert.ok(saved.next_run > f.now());
    await executeScheduledTask(f.sql, 'alice', task.id, f.request('tasks/' + task.id + '/run', 'POST'), executor, { now: f.now });
    assert.equal(executions, 1);
  } finally { f.close(); }
});

test('local schedule parsing round-trips real IANA zones and rejects nonexistent calendar dates', () => {
  const time = parseScheduleDateTime('2026-11-05T09:30', 'Asia/Seoul');
  assert.equal(new Date(time).toISOString(), '2026-11-05T00:30:00.000Z');
  assert.equal(formatScheduleDateTime(time, 'Asia/Seoul'), '2026-11-05T09:30');
  assert.throws(() => parseScheduleDateTime('2026-02-30T09:30', 'UTC'));
  assert.throws(() => parseScheduleDateTime('2026-11-05T25:30', 'UTC'));
  assert.throws(() => parseScheduleDateTime('2026-11-05T09:30', 'invalid-zone'));
  assert.throws(() => parseScheduleDateTime('2026-03-08T02:30', 'America/New_York'));
});

test('daily and weekly recurrence preserve local clock times across daylight-saving changes', () => {
  const anchor = Date.parse('2026-03-07T14:00:00Z');
  assert.equal(new Date(nextScheduledAt(anchor, 'daily', 'America/New_York', Date.parse('2026-03-08T01:00:00Z'))).toISOString(), '2026-03-08T13:00:00.000Z');
  assert.equal(new Date(nextScheduledAt(anchor, 'weekly', 'America/New_York', anchor)).toISOString(), '2026-03-14T13:00:00.000Z');
  const early = Date.parse('2026-03-07T07:30:00Z');
  assert.equal(new Date(nextScheduledAt(early, 'daily', 'America/New_York', early)).toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(new Date(nextScheduledAt(early, 'daily', 'America/New_York', Date.parse('2026-03-08T07:30:00Z'))).toISOString(), '2026-03-09T06:30:00.000Z');
  assert.equal(new Date(parseScheduleDateTime('2026-11-01T01:30', 'America/New_York')).toISOString(), '2026-11-01T05:30:00.000Z');
});
