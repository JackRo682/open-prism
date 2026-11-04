'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AlertDialog } from 'radix-ui';
import { AlertCircle, ArrowLeft, ArrowUpRight, CalendarClock, Check, Clock3, LoaderCircle, Pause, Pencil, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import type { ScheduledTask } from '../../lib/scheduled-tasks';
import { formatScheduleDateTime, isTimeZone, parseScheduleDateTime, type ScheduleRecurrence } from '../../lib/schedule-time';

type TasksResponse = { tasks: ScheduledTask[]; runnerReady: boolean };
type TaskForm = { id?: string; title: string; prompt: string; recurrence: ScheduleRecurrence; date: string; timezone: string; enabled: boolean; model: string };
export type TaskManagerProps = {
  signedIn: boolean;
  onNavigate(path: string): void;
  modelId?: string;
  onRunComplete?(conversationId: string): void;
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api/' + path, options);
  let body: T & { error?: string };
  try { body = await response.json(); } catch { throw new Error('서버 응답을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
  if (!response.ok) throw new Error(body.error || '요청을 처리하지 못했습니다.');
  return body;
}
const mutation = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
const recurrenceLabel: Record<ScheduleRecurrence, string> = { once: '한 번', daily: '매일', weekly: '매주' };
const statusLabel: Record<ScheduledTask['status'], string> = { draft: '초안', active: '자동 실행 켜짐', paused: '일시정지', running: '실행 중', completed: '완료', error: '실행 오류' };
const isRunning = (task: ScheduledTask) => task.status === 'running' && (task.running_until ?? Infinity) > Date.now();
const runLabel = (task: ScheduledTask) => task.status === 'running' && !isRunning(task) ? '완료 확인 필요' : statusLabel[task.status];

function formatDate(value: number | null, timezone: string) {
  if (value === null) return '없음';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, year: 'numeric', month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(value);
}
function emptyForm(model: string): TaskForm {
  let timezone = 'Asia/Seoul';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || timezone; } catch {}
  return { title: '', prompt: '', recurrence: 'once', date: formatScheduleDateTime(Date.now() + 3_600_000, timezone), timezone, enabled: false, model };
}

export function TaskManager({ signedIn, onNavigate, modelId = 'gpt-6.1-sol', onRunComplete }: TaskManagerProps) {
  const [data, setData] = useState<TasksResponse>({ tasks: [], runnerReady: false });
  const [loading, setLoading] = useState(signedIn), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [form, setForm] = useState<TaskForm | null>(null), [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(''), [deleting, setDeleting] = useState<ScheduledTask | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const prefix = useId(), titleRef = useRef<HTMLInputElement>(null), mounted = useRef(true);
  const requestAbort = useRef<AbortController | null>(null);
  const restoredDraft = useRef(false);
  function rememberForm() {
    if (!form || form.id || (!form.title.trim() && !form.prompt.trim())) return;
    try { sessionStorage.setItem('prism-task-signin-draft:v1', JSON.stringify({ form, savedAt: Date.now() })); } catch {}
  }
  useEffect(() => {
    try {
      if (!restoredDraft.current) {
        restoredDraft.current = true;
        const saved = JSON.parse(sessionStorage.getItem('prism-task-signin-draft:v1') || 'null');
        const value = saved?.form, age = Date.now() - saved?.savedAt;
        if (value && !value.id && Number.isFinite(age) && age >= 0 && age < 3_600_000
          && typeof value.title === 'string' && value.title.length <= 100 && typeof value.prompt === 'string' && value.prompt.length <= 8000
          && typeof value.date === 'string' && value.date.length <= 30 && isTimeZone(value.timezone)
          && ['once', 'daily', 'weekly'].includes(value.recurrence) && typeof value.model === 'string' && value.model.length <= 100) {
          setForm({ title: value.title, prompt: value.prompt, date: value.date, timezone: value.timezone, recurrence: value.recurrence, model: value.model, enabled: false });
        }
      }
      if (signedIn) sessionStorage.removeItem('prism-task-signin-draft:v1');
    } catch {}
  }, [signedIn]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestAbort.current?.abort(); }; }, []);
  useEffect(() => {
    if (!signedIn) { setLoading(false); setData({ tasks: [], runnerReady: false }); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    request<TasksResponse>('tasks', { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '작업을 불러오지 못했습니다.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [signedIn, refreshKey]);
  useEffect(() => { if (form) titleRef.current?.focus(); }, [form?.id, !!form]);

  const upsert = (task: ScheduledTask) => setData(previous => ({ ...previous, tasks: [task, ...previous.tasks.filter(item => item.id !== task.id)].sort((a, b) => b.created_at - a.created_at) }));
  function edit(task: ScheduledTask) {
    setFormError(''); setNotice('');
    setForm({ id: task.id, title: task.title, prompt: task.prompt, recurrence: task.recurrence, date: formatScheduleDateTime(task.next_run ?? task.scheduled_at, task.timezone), timezone: task.timezone, enabled: task.enabled, model: task.model });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form || busy || !signedIn) return;
    setFormError(''); setNotice('');
    let scheduledAt: number;
    try { scheduledAt = parseScheduleDateTime(form.date, form.timezone); }
    catch (cause) { setFormError(cause instanceof Error ? cause.message : '실행 시각을 확인해 주세요.'); return; }
    if (scheduledAt <= Date.now()) { setFormError('실행 시각은 현재보다 나중이어야 합니다.'); return; }
    setBusy('save');
    try {
      const result = await request<{ task: ScheduledTask }>('tasks' + (form.id ? '/' + form.id : ''), mutation(form.id ? 'PATCH' : 'POST', {
        title: form.title, prompt: form.prompt, recurrence: form.recurrence, timezone: form.timezone,
        scheduledAt, enabled: form.enabled && data.runnerReady, model: form.model,
      }));
      if (!mounted.current) return;
      upsert(result.task); setForm(null);
      setNotice(result.task.enabled ? '작업을 저장하고 자동 실행을 켰습니다.' : '작업을 저장했습니다. 지금 실행할 수 있습니다.');
    } catch (cause) { if (mounted.current) setFormError(cause instanceof Error ? cause.message : '작업을 저장하지 못했습니다.'); }
    finally { if (mounted.current) setBusy(''); }
  }
  async function toggle(task: ScheduledTask) {
    if (busy) return;
    setBusy(task.id); setError(''); setNotice('');
    try {
      const result = await request<{ task: ScheduledTask }>('tasks/' + task.id, mutation('PATCH', { enabled: !task.enabled }));
      if (mounted.current) { upsert(result.task); setNotice(result.task.enabled ? '자동 실행을 켰습니다.' : '자동 실행을 일시정지했습니다.'); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '작업 설정을 변경하지 못했습니다.'); }
    finally { if (mounted.current) setBusy(''); }
  }
  async function run(task: ScheduledTask) {
    if (busy) return;
    const controller = new AbortController(); requestAbort.current = controller;
    setBusy(task.id); setError(''); setNotice('');
    upsert({ ...task, status: 'running', running_until: Date.now() + 300_000 });
    try {
      const result = await request<{ task: ScheduledTask; conversationId: string }>('tasks/' + task.id + '/run', { ...mutation('POST'), signal: controller.signal });
      if (!mounted.current) return;
      upsert(result.task); setNotice('실행을 완료했습니다. 결과는 대화 기록에 저장되었습니다.');
      onRunComplete?.(result.conversationId);
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : '작업을 실행하지 못했습니다.'); setRefreshKey(value => value + 1); }
    } finally { if (mounted.current) setBusy(''); requestAbort.current = null; }
  }
  async function remove(task: ScheduledTask) {
    if (busy) return;
    setBusy(task.id); setError(''); setNotice('');
    try {
      await request('tasks/' + task.id, mutation('DELETE'));
      if (mounted.current) {
        setData(previous => ({ ...previous, tasks: previous.tasks.filter(item => item.id !== task.id) }));
        if (form?.id === task.id) setForm(null);
        setDeleting(null); setNotice('작업을 삭제했습니다. 이전 실행의 대화 기록은 남아 있습니다.');
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '작업을 삭제하지 못했습니다.'); }
    finally { if (mounted.current) setBusy(''); }
  }

  return <section className="prism-feature-page prism-task-page" aria-labelledby={prefix + '-heading'}>
    <div className="prism-feature-heading">
      <button className="prism-feature-back" onClick={() => onNavigate('/chat')} aria-label="채팅으로 돌아가기"><ArrowLeft size={20}/></button>
      <div><h1 id={prefix + '-heading'}>예약된 작업</h1><p>다시 할 일을 저장하고 원하는 시각에 실행하세요.</p></div>
      <button className="prism-feature-button primary" disabled={!!busy} onClick={() => { setForm(emptyForm(modelId)); setFormError(''); }}><Plus size={18}/>새 작업</button>
    </div>
    {!signedIn ? <div className="prism-feature-notice"><Clock3 size={20}/><div><strong>로그인하고 작업을 저장하세요.</strong><p>내 계정에서만 작업과 실행 결과를 확인할 수 있습니다.</p><a className="prism-feature-button primary" href="/signin-with-chatgpt?return_to=%2Fscheduled" target="_top" onClick={rememberForm}>ChatGPT로 로그인<ArrowUpRight size={16}/></a></div></div>
      : !loading && <div className={'prism-feature-notice ' + (data.runnerReady ? 'ready' : '')} role="status">{data.runnerReady ? <Check size={20}/> : <CalendarClock size={20}/>}<div><strong>{data.runnerReady ? '자동 실행을 사용할 수 있습니다.' : '자동 실행 서비스 연결이 필요합니다.'}</strong><p>{data.runnerReady ? '자동 실행이 켜진 작업은 이 화면을 닫아도 예약에 따라 실행됩니다.' : '작업을 초안으로 저장하고 지금 실행할 수 있습니다. 자동 실행은 서비스 연결 후 켤 수 있습니다.'}</p></div></div>}
    {notice && <p className="prism-feature-status success" role="status"><Check size={18}/>{notice}</p>}
    {error && <div className="prism-feature-status error" role="alert"><AlertCircle size={18}/><span>{error}</span><button className="prism-feature-link" disabled={loading || !!busy} onClick={() => setRefreshKey(value => value + 1)}>다시 불러오기</button></div>}

    {form && <form className="prism-feature-card prism-task-form" onSubmit={save}>
      <div className="prism-feature-section-heading"><h2>{form.id ? '작업 수정' : '새 작업'}</h2><button type="button" className="prism-feature-icon" aria-label="작업 편집 닫기" disabled={!!busy} onClick={() => setForm(null)}><X size={19}/></button></div>
      <label className="prism-feature-field" htmlFor={prefix + '-title'}><span>작업 이름</span><input ref={titleRef} id={prefix + '-title'} required maxLength={100} value={form.title} disabled={!!busy} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="예: 매일 공부할 내용 정리"/></label>
      <label className="prism-feature-field" htmlFor={prefix + '-prompt'}><span>AI가 할 일</span><textarea id={prefix + '-prompt'} required maxLength={8000} rows={5} value={form.prompt} disabled={!!busy} onChange={event => setForm({ ...form, prompt: event.target.value })} placeholder="할 일과 원하는 결과를 구체적으로 적어 주세요."/><small>{form.prompt.length.toLocaleString('ko-KR')} / 8,000자</small></label>
      <div className="prism-feature-form-grid">
        <label className="prism-feature-field" htmlFor={prefix + '-date'}><span>첫 실행 시각</span><input id={prefix + '-date'} required type="datetime-local" value={form.date} disabled={!!busy} onChange={event => setForm({ ...form, date: event.target.value })}/></label>
        <label className="prism-feature-field" htmlFor={prefix + '-recurrence'}><span>반복</span><select id={prefix + '-recurrence'} value={form.recurrence} disabled={!!busy} onChange={event => setForm({ ...form, recurrence: event.target.value as ScheduleRecurrence })}><option value="once">한 번</option><option value="daily">매일 같은 시각</option><option value="weekly">매주 같은 요일과 시각</option></select></label>
      </div>
      <label className="prism-feature-field" htmlFor={prefix + '-timezone'}><span>시간대</span><input id={prefix + '-timezone'} list={prefix + '-zones'} required maxLength={80} value={form.timezone} disabled={!!busy} onChange={event => setForm({ ...form, timezone: event.target.value })}/><datalist id={prefix + '-zones'}>{['Asia/Seoul', 'Asia/Tokyo', 'UTC', 'Europe/Berlin', 'Europe/London', 'America/New_York', 'America/Los_Angeles'].map(zone => <option value={zone} key={zone}/>)}</datalist><small>{isTimeZone(form.timezone) ? '입력한 날짜와 시각은 이 시간대를 기준으로 합니다.' : '올바른 IANA 시간대를 입력해 주세요. 예: Asia/Seoul'}</small></label>
      <label className="prism-feature-check"><input type="checkbox" checked={form.enabled && data.runnerReady} disabled={!data.runnerReady || !!busy} onChange={event => setForm({ ...form, enabled: event.target.checked })}/><span>저장 후 자동 실행 켜기{!data.runnerReady && <small>서비스 연결 후 사용할 수 있습니다.</small>}</span></label>
      {formError && <p className="prism-feature-status error" role="alert"><AlertCircle size={17}/>{formError}</p>}
      <div className="prism-feature-form-actions"><button type="button" className="prism-feature-button" disabled={!!busy} onClick={() => setForm(null)}>취소</button>{signedIn ? <button className="prism-feature-button primary" type="submit" disabled={!!busy || !form.title.trim() || !form.prompt.trim()}>{busy === 'save' && <LoaderCircle className="spin" size={16}/>}작업 저장</button> : <a className="prism-feature-button primary" href="/signin-with-chatgpt?return_to=%2Fscheduled" target="_top" onClick={rememberForm}>로그인하고 저장</a>}</div>
    </form>}

    {signedIn && <div className="prism-feature-section-heading"><h2>내 작업 <span className="prism-feature-count">{data.tasks.length}</span></h2><button className="prism-feature-icon" disabled={loading || !!busy} onClick={() => setRefreshKey(value => value + 1)} aria-label="작업 목록 새로고침"><RefreshCw size={18} className={loading ? 'spin' : ''}/></button></div>}
    {signedIn && loading && !data.tasks.length && <p className="prism-feature-status" role="status"><LoaderCircle className="spin" size={18}/>작업을 불러오는 중…</p>}
    {signedIn && !loading && !error && !data.tasks.length && <div className="prism-feature-empty"><CalendarClock size={34}/><h2>아직 저장한 작업이 없습니다.</h2><p>자주 요청하는 내용을 새 작업으로 저장하세요.</p><button className="prism-feature-button" onClick={() => { setForm(emptyForm(modelId)); setFormError(''); }}><Plus size={17}/>첫 작업 만들기</button></div>}
    <div className="prism-task-list" aria-busy={loading}>
      {data.tasks.map(task => <article className="prism-feature-card prism-task-card" key={task.id}>
        <div className="prism-feature-section-heading"><h3>{task.title}</h3><span className={'prism-task-badge ' + task.status}>{isRunning(task) && <LoaderCircle className="spin" size={14}/>} {runLabel(task)}</span></div>
        <p className="prism-task-prompt">{task.prompt}</p>
        <dl className="prism-task-metadata"><div><dt>{task.enabled ? '다음 실행' : task.status === 'completed' ? '예약 완료' : '설정한 시각'}</dt><dd>{formatDate(task.next_run ?? (task.status === 'completed' ? null : task.scheduled_at), task.timezone)}</dd></div><div><dt>반복</dt><dd>{recurrenceLabel[task.recurrence]} · {task.timezone}</dd></div>{task.last_run !== null && <div><dt>최근 실행</dt><dd>{formatDate(task.last_run, task.timezone)}</dd></div>}</dl>
        {task.last_error && <p className="prism-feature-status error"><AlertCircle size={16}/>{task.last_error}</p>}
        <div className="prism-task-actions">
          <button className="prism-feature-button primary" disabled={!!busy || isRunning(task)} onClick={() => run(task)}>{busy === task.id && isRunning(task) ? <LoaderCircle className="spin" size={16}/> : <Play size={16}/>}지금 실행</button>
          {task.last_conversation_id && <button className="prism-feature-button" onClick={() => onNavigate('/chat/' + task.last_conversation_id)}>결과 보기<ArrowUpRight size={15}/></button>}
          <button className="prism-feature-button" disabled={!!busy || isRunning(task)} onClick={() => edit(task)}><Pencil size={15}/>수정</button>
          <button className="prism-feature-button" disabled={!!busy || isRunning(task) || (!task.enabled && !data.runnerReady)} title={!task.enabled && !data.runnerReady ? '자동 실행 서비스 연결이 필요합니다.' : undefined} onClick={() => toggle(task)}>{task.enabled ? <Pause size={15}/> : <Clock3 size={15}/>} {task.enabled ? '일시정지' : '자동 실행 켜기'}</button>
          <button className="prism-feature-icon danger" disabled={!!busy || isRunning(task)} aria-label={task.title + ' 삭제'} onClick={() => { setError(''); setDeleting(task); }}><Trash2 size={17}/></button>
        </div>
        {task.enabled && <p className="prism-task-run-note">지금 실행해도 다음 예약은 유지됩니다.</p>}
      </article>)}
    </div>
    <AlertDialog.Root open={!!deleting} onOpenChange={open => { if (!open && !busy) setDeleting(null); }}><AlertDialog.Portal><AlertDialog.Overlay className="prism-dialog-overlay"/><AlertDialog.Content className="prism-dialog-content prism-feature-confirm"><AlertDialog.Title>이 작업을 삭제할까요?</AlertDialog.Title><AlertDialog.Description>“{deleting?.title}” 예약을 삭제합니다. 이전 실행으로 저장된 대화는 삭제되지 않습니다.</AlertDialog.Description>{error && <p className="prism-feature-status error" role="alert">{error}</p>}<div className="prism-feature-form-actions"><AlertDialog.Cancel className="prism-feature-button" disabled={!!busy}>취소</AlertDialog.Cancel><button className="prism-feature-button danger" disabled={!!busy} onClick={() => deleting && remove(deleting)}>{busy && <LoaderCircle className="spin" size={16}/>}삭제</button></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
  </section>;
}
