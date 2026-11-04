'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog, Switch } from 'radix-ui';
import { BrowserSettingsPage } from './browser-settings';
import {
  AlertCircle, ArrowLeft, ArrowUpRight, Check, ChevronRight, Clock3,
  Copy, Diamond, FileText, Globe2, Image, Link2,
  LoaderCircle, Plus, ScrollText, ShieldCheck, Trash2, Video,
} from 'lucide-react';

type Skill = { id: string; name: string; instructions: string };
type WorkspaceSettings = {
  personalizationEnabled: boolean;
  customInstructions: string;
  memory: string;
  workResponseStyle: 'plan-first' | 'direct';
  skills: Skill[];
};
type ShareRecord = { id: string; token: string; title: string; created_at: number };

export interface SettingsPagesProps {
  pathname: string;
  signedIn: boolean;
  onNavigate: (path: string) => void;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
}

const pageTitles: Record<string, [string, string]> = {
  '/personalization-settings': ['개인 인텔리전스', '답변에 반영할 나의 정보와 지침을 관리하세요.'],
  '/gemini-spark': ['작업 설정', '작업 모드의 답변 방식을 설정하세요.'],
  '/browser-settings': ['브라우저', '현재 브라우저와 원격 작업 기능의 연결 상태입니다.'],
  '/customize/skills': ['스킬', '자주 사용하는 지침을 저장하고 대화에서 불러오세요.'],
  '/gems/view': ['Gems', '내가 만든 지침으로 AI와 함께 작업하세요.'],
  '/import': ['Prism으로 메모리 가져오기', '다른 서비스에서 정리한 내용을 확인한 후 저장하세요.'],
  '/sharing': ['내 공개 링크', '공유한 대화의 링크를 확인하고 관리하세요.'],
  '/feedback': ['의견 보내기', '개선할 점이나 발견한 문제를 알려 주세요.'],
  '/images': ['이미지', '이미지 생성 및 편집'],
  '/videos': ['동영상', '동영상 생성'],
  '/scheduled': ['예약됨', '예약된 작업'],
};

export function isSettingsPage(pathname: string) {
  return pathname in pageTitles || pathname.startsWith('/share/');
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, options);
  let data: T & { error?: string };
  try { data = await response.json(); }
  catch { throw new Error('서버 응답을 읽을 수 없습니다. 잠시 후 다시 시도해 주세요.'); }
  if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
  return data;
}

function useSettings() {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    request<WorkspaceSettings>('settings', { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setSettings(data); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '설정을 불러오지 못했습니다.'); });
    return () => controller.abort();
  }, [attempt]);

  async function save(patch: Partial<WorkspaceSettings>) {
    setSaving(true);
    setError('');
    try {
      const data = await request<WorkspaceSettings>('settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      setSettings(data);
      return data;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '설정을 저장하지 못했습니다.');
      return null;
    } finally { setSaving(false); }
  }
  return { settings, setSettings, error, saving, save, retry: () => setAttempt((value) => value + 1) };
}

function LoadingOrError({ error, retry }: { error: string; retry: () => void }) {
  return error ? <div className="prism-setting-card"><p className="prism-setting-status error" role="alert"><AlertCircle size={18} />{error}</p><button className="prism-action-button" onClick={retry}>다시 시도</button></div>
    : <p className="prism-setting-status" role="status"><LoaderCircle className="spin" size={18} />설정 불러오는 중…</p>;
}

function ErrorMessage({ message }: { message: string }) {
  return message ? <p className="prism-setting-status error" role="alert"><AlertCircle size={17} />{message}</p> : null;
}

function useDialogReturnFocus() {
  const returnFocus = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      const target = returnFocus.current?.isConnected ? returnFocus.current : document.querySelector<HTMLElement>('.prism-back-button');
      target?.focus();
    },
  };
}

function SignInCard({ pathname }: { pathname: string }) {
  return <section className="prism-setting-card prism-capability-state"><ShieldCheck size={28} /><h2>로그인하고 이어서 사용하세요</h2><p>설정과 데이터는 로그인한 계정에 저장됩니다.</p><a className="prism-action-button primary" target="_top" href={`/signin-with-chatgpt?return_to=${encodeURIComponent(pathname)}`}>ChatGPT로 로그인 <ArrowUpRight size={15} /></a></section>;
}

function PersonalizationPage({ onNavigate, onNotice }: Pick<SettingsPagesProps, 'onNavigate' | 'onNotice'>) {
  const { settings, setSettings, error, saving, save, retry } = useSettings();
  const [saved, setSaved] = useState(false);
  if (!settings) return <LoadingOrError error={error} retry={retry} />;
  const update = (patch: Partial<WorkspaceSettings>) => { setSettings({ ...settings, ...patch }); setSaved(false); };

  return <>
    <section className="prism-setting-card">
      <div className="prism-setting-row">
        <div><h2>개인화</h2><p>저장한 메모리와 지침을 새로운 AI 요청에 반영합니다.</p></div>
        <Switch.Root className="prism-switch" checked={settings.personalizationEnabled} onCheckedChange={(value) => update({ personalizationEnabled: value })} aria-label="개인화 사용" disabled={saving}><Switch.Thumb className="prism-switch-thumb" /></Switch.Root>
      </div>
    </section>
    <section className="prism-setting-card">
      <h2>Prism을 위한 지침</h2><p>원하는 답변 방식, 언어, 작업 규칙을 알려 주세요.</p>
      <label className="prism-settings-field" htmlFor="prism-custom-instructions">맞춤 지침<textarea id="prism-custom-instructions" value={settings.customInstructions} maxLength={4000} disabled={saving} onChange={(event) => update({ customInstructions: event.target.value })} placeholder="예: 한국어로 답하고, 결론부터 설명해 주세요." /><small>{settings.customInstructions.length.toLocaleString()} / 4,000자</small></label>
    </section>
    <section className="prism-setting-card">
      <h2>메모리</h2><p>답변에 참고할 선호와 작업 맥락입니다. 직접 검토하고 수정할 수 있습니다.</p>
      <label className="prism-settings-field" htmlFor="prism-memory">저장할 내용<textarea id="prism-memory" value={settings.memory} maxLength={8000} disabled={saving} onChange={(event) => update({ memory: event.target.value })} placeholder="자주 작업하는 프로젝트나 기억해 둘 선호를 적어 주세요." /><small>{settings.memory.length.toLocaleString()} / 8,000자</small></label>
    </section>
    <ErrorMessage message={error} />
    <div className="prism-setting-actions"><span aria-live="polite">{saved ? '설정이 저장되었습니다.' : '저장한 변경 사항은 다음 메시지부터 적용됩니다.'}</span><button className="prism-action-button primary" disabled={saving} onClick={async () => { if (await save({ personalizationEnabled: settings.personalizationEnabled, customInstructions: settings.customInstructions, memory: settings.memory })) { setSaved(true); onNotice?.('개인화 설정을 저장했습니다.'); } }}>{saving ? <LoaderCircle size={16} className="spin" /> : saved ? <Check size={16} /> : null}{saving ? '저장 중…' : '변경 사항 저장'}</button></div>
    <button className="prism-setting-card prism-setting-link" onClick={() => onNavigate('/settings')}><Globe2 size={23} /><span><strong>연결된 AI 서비스</strong><small>OpenAI, Anthropic, Google의 연결 상태 확인</small></span><ChevronRight size={18} /></button>
    <button className="prism-setting-card prism-setting-link" onClick={() => onNavigate('/import')}><FileText size={23} /><span><strong>메모리 가져오기</strong><small>다른 서비스에서 정리한 내용을 검토하고 저장</small></span><ChevronRight size={18} /></button>
  </>;
}

function WorkPage({ onNotice }: Pick<SettingsPagesProps, 'onNotice'>) {
  const { settings, setSettings, error, saving, save, retry } = useSettings();
  if (!settings) return <LoadingOrError error={error} retry={retry} />;
  return <>
    <section className="prism-setting-card"><h2>작업 답변 방식</h2><p>작업 모드에서 사용할 답변 지침을 설정합니다. 이 지침은 서버에서 AI 요청에 반영합니다.</p><label className="prism-settings-field" htmlFor="prism-work-style">진행 방식<select id="prism-work-style" value={settings.workResponseStyle} disabled={saving} onChange={(event) => setSettings({ ...settings, workResponseStyle: event.target.value as WorkspaceSettings['workResponseStyle'] })}><option value="plan-first">계획을 먼저 설명</option><option value="direct">결과부터 설명</option></select></label><div className="prism-setting-actions"><button className="prism-action-button primary" disabled={saving} onClick={async () => { if (await save({ workResponseStyle: settings.workResponseStyle })) onNotice?.('작업 설정을 저장했습니다.'); }}>{saving ? <LoaderCircle size={16} className="spin" /> : null}{saving ? '저장 중…' : '저장'}</button></div><ErrorMessage message={error} /></section>
    <section className="prism-setting-card"><div className="prism-setting-row"><div><h2>원격 코드 실행</h2><p>현재 Prism은 대화로 계획과 코드를 제공합니다. 원격 실행 환경이 연결되어 있지 않아 코드를 실행하거나 외부 작업을 수행하지 않습니다.</p></div><span className="prism-status-pill">연결 안 됨</span></div></section>
    <section className="prism-setting-card"><h2>작업 전달</h2><p>답변은 현재 대화에 표시됩니다. 백그라운드 실행 및 예약 작업은 아직 연결되어 있지 않습니다.</p></section>
  </>;
}

function SkillsPage({ onNotice }: Pick<SettingsPagesProps, 'onNotice'>) {
  const { settings, error, saving, save, retry } = useSettings();
  const [editing, setEditing] = useState<Skill | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Skill | null>(null);
  const dialogFocus = useDialogReturnFocus();
  if (!settings) return <LoadingOrError error={error} retry={retry} />;
  const skills = settings.skills || [];
  return <>
    <div className="prism-setting-row"><p className="prism-subtle-note">스킬은 대화에 적용하는 저장된 지침입니다. 코드나 외부 앱을 자동 실행하지 않습니다.</p><button className="prism-action-button" disabled={saving || skills.length >= 20} onClick={() => setEditing({ id: crypto.randomUUID(), name: '', instructions: '' })}><Plus size={16} />새 스킬</button></div>
    <ErrorMessage message={error} />
    {skills.length ? <div className="prism-share-list">{skills.map((skill) => <section className="prism-share-record" key={skill.id}><ScrollText size={20} /><div><h2>{skill.name}</h2><p className="prism-subtle-note">{skill.instructions.slice(0, 160)}{skill.instructions.length > 160 ? '…' : ''}</p><button className="prism-action-button prism-skill-edit" onClick={() => setEditing(skill)}>수정</button></div><button aria-label={`${skill.name} 삭제`} disabled={saving} onClick={() => setConfirmDelete(skill)}><Trash2 size={17} /></button></section>)}</div> : <section className="prism-setting-card prism-capability-state"><ScrollText size={30} /><h2>나만의 스킬을 만들어 보세요</h2><p>반복해서 사용하는 작업 지침을 저장하면 새 대화에서 @로 불러올 수 있습니다.</p><button className="prism-action-button primary" onClick={() => setEditing({ id: crypto.randomUUID(), name: '', instructions: '' })}><Plus size={16} />스킬 만들기</button></section>}
    <Dialog.Root open={editing !== null} onOpenChange={(open) => { if (!open && !saving) setEditing(null); }}><Dialog.Portal><Dialog.Overlay className="prism-dialog-overlay" /><Dialog.Content className="prism-confirm-dialog" {...dialogFocus}><Dialog.Title>{editing && skills.some((skill) => skill.id === editing.id) ? '스킬 수정' : '새 스킬'}</Dialog.Title><Dialog.Description>저장한 지침을 선택한 대화에서 사용할 수 있습니다.</Dialog.Description>{editing && <><label className="prism-settings-field" htmlFor="prism-skill-name">이름<input id="prism-skill-name" value={editing.name} maxLength={60} disabled={saving} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label><label className="prism-settings-field" htmlFor="prism-skill-instructions">지침<textarea id="prism-skill-instructions" value={editing.instructions} maxLength={4000} disabled={saving} onChange={(event) => setEditing({ ...editing, instructions: event.target.value })} /><small>{editing.instructions.length.toLocaleString()} / 4,000자</small></label><ErrorMessage message={error} /><div className="prism-setting-actions"><button className="prism-action-button" disabled={saving} onClick={() => setEditing(null)}>취소</button><button className="prism-action-button primary" disabled={saving || !editing.name.trim() || !editing.instructions.trim()} onClick={async () => { const next = { ...editing, name: editing.name.trim(), instructions: editing.instructions.trim() }; const updated = skills.some((skill) => skill.id === next.id) ? skills.map((skill) => skill.id === next.id ? next : skill) : [...skills, next]; if (await save({ skills: updated })) { setEditing(null); onNotice?.('스킬을 저장했습니다.'); } }}>{saving ? '저장 중…' : '저장'}</button></div></>}</Dialog.Content></Dialog.Portal></Dialog.Root>
    <Confirmation open={confirmDelete !== null} onOpenChange={(open) => { if (!open && !saving) setConfirmDelete(null); }} title="스킬을 삭제할까요?" description={confirmDelete ? `“${confirmDelete.name}” 지침을 삭제합니다. 기존 대화는 그대로 유지됩니다.` : ''} busy={saving} confirmLabel="삭제" onConfirm={async () => { if (confirmDelete && await save({ skills: skills.filter((skill) => skill.id !== confirmDelete.id) })) { setConfirmDelete(null); onNotice?.('스킬을 삭제했습니다.'); } }} />
  </>;
}

const memoryExportPrompt = '내가 직접 공유한 선호, 작업 방식, 선호하는 답변 형식과 현재 프로젝트를 다른 AI 서비스에서 사용할 수 있도록 간결하게 정리해 주세요. 확인된 내용만 포함하고, 내가 말하지 않은 정보는 추측하지 마세요. 내가 검토하고 수정하기 쉬운 일반 텍스트로 작성해 주세요.';

function ImportPage({ onNotice }: Pick<SettingsPagesProps, 'onNotice'>) {
  const { settings, error, saving, save, retry } = useSettings();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [copied, setCopied] = useState(false);
  const dialogFocus = useDialogReturnFocus();
  if (!settings) return <LoadingOrError error={error} retry={retry} />;
  return <>
    <section className="prism-setting-card"><h2>1. 가져올 내용 준비</h2><p>아래 요청을 기존 AI 서비스에 입력해 메모리를 정리한 뒤 내용을 복사해 주세요.</p><div className="prism-setting-actions"><button className="prism-action-button" onClick={async () => { try { await navigator.clipboard.writeText(memoryExportPrompt); setCopied(true); setCopyError(''); } catch { setCopyError('클립보드에 접근할 수 없습니다. 아래 요청을 직접 복사해 주세요.'); } }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '복사됨' : '요청 복사'}</button></div><details className="prism-subtle-note"><summary>요청 내용 보기</summary><p>{memoryExportPrompt}</p></details><ErrorMessage message={copyError} /></section>
    <section className="prism-setting-card"><h2>2. 내용 붙여넣기</h2><p>저장하기 전에 내용을 수정하고 확인할 수 있습니다.</p><label className="prism-settings-field" htmlFor="prism-import-memory">가져올 메모리<textarea id="prism-import-memory" value={text} maxLength={8000} onChange={(event) => setText(event.target.value)} placeholder="정리한 메모리를 여기에 붙여넣으세요." /><small>{text.length.toLocaleString()} / 8,000자</small></label><div className="prism-setting-actions"><button className="prism-action-button primary" disabled={!text.trim() || saving} onClick={() => setPreview(true)}>확인 후 가져오기</button></div></section>
    <section className="prism-setting-card"><h2>대화 가져오기</h2><p>이 화면에서는 메모리 텍스트를 가져올 수 있습니다. 다른 서비스의 대화 파일 가져오기는 아직 지원하지 않습니다.</p></section>
    <ErrorMessage message={error} />
    <Dialog.Root open={preview} onOpenChange={(open) => { if (!saving) setPreview(open); }}><Dialog.Portal><Dialog.Overlay className="prism-dialog-overlay" /><Dialog.Content className="prism-confirm-dialog" {...dialogFocus}><Dialog.Title>메모리를 가져올까요?</Dialog.Title><Dialog.Description>아래 내용으로 기존 메모리를 교체합니다. 개인화 사용 설정은 유지됩니다.</Dialog.Description><pre className="prism-import-preview">{text.trim()}</pre><ErrorMessage message={error} /><div className="prism-setting-actions"><button className="prism-action-button" disabled={saving} onClick={() => setPreview(false)}>취소</button><button className="prism-action-button primary" disabled={saving} onClick={async () => { if (await save({ memory: text.trim() })) { setPreview(false); setText(''); onNotice?.(settings.personalizationEnabled ? '메모리를 가져왔습니다. 다음 메시지부터 반영됩니다.' : '메모리를 가져왔습니다. 개인화를 켜면 답변에 반영됩니다.'); } }}>{saving ? '가져오는 중…' : '메모리 교체'}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}

function Confirmation({ open, onOpenChange, title, description, busy, confirmLabel, onConfirm }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; busy: boolean; confirmLabel: string; onConfirm: () => Promise<void>;
}) {
  const dialogFocus = useDialogReturnFocus();
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="prism-dialog-overlay" /><Dialog.Content className="prism-confirm-dialog" {...dialogFocus}><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description><div className="prism-setting-actions"><Dialog.Close className="prism-action-button" disabled={busy}>취소</Dialog.Close><button className="prism-action-button primary" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle size={15} className="spin" /> : null}{busy ? '처리 중…' : confirmLabel}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function SharingPage({ onNavigate, onNotice }: Pick<SettingsPagesProps, 'onNavigate' | 'onNotice'>) {
  const [shares, setShares] = useState<ShareRecord[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [deleting, setDeleting] = useState<ShareRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setOrigin(window.location.origin);
    setError('');
    request<{ shares: ShareRecord[] }>('shares', { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setShares(data.shares); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '링크를 불러오지 못했습니다.'); });
    return () => controller.abort();
  }, [attempt]);
  if (!shares) return <LoadingOrError error={error} retry={() => setAttempt((value) => value + 1)} />;
  return <>
    <ErrorMessage message={error} />
    {shares.length ? <div className="prism-share-list">{shares.map((share) => {
      const url = `${origin}/share/${encodeURIComponent(share.token)}`;
      return <section className="prism-share-record" key={share.id}><Link2 size={20} /><div><h2>{share.title}</h2><a href={url} target="_blank" rel="noreferrer">{url}</a><time dateTime={new Date(share.created_at).toISOString()}>{new Date(share.created_at).toLocaleDateString('ko-KR')}</time></div><div className="prism-setting-actions"><button aria-label={`${share.title} 링크 복사`} onClick={async () => { try { await navigator.clipboard.writeText(url); onNotice?.('공개 링크를 복사했습니다.'); } catch { setError('클립보드에 접근할 수 없습니다. 링크를 직접 복사해 주세요.'); } }}><Copy size={16} /></button><button aria-label={`${share.title} 공유 취소`} disabled={busy} onClick={() => setDeleting(share)}><Trash2 size={16} /></button></div></section>;
    })}</div> : <section className="prism-setting-card prism-capability-state"><Link2 size={30} /><h2>아직 공개 링크가 없습니다</h2><p>대화에서 공유 버튼을 누르면 해당 시점의 대화를 링크로 공유할 수 있습니다.</p><button className="prism-action-button" onClick={() => onNavigate('/history')}>내 대화 보기 <ChevronRight size={15} /></button></section>}
    <p className="prism-subtle-note">공개 링크는 생성 당시의 대화 사본입니다. 공유를 취소하면 해당 링크로 대화를 읽을 수 없습니다.</p>
    <Confirmation open={deleting !== null} onOpenChange={(open) => { if (!open && !busy) setDeleting(null); }} title="공유를 취소할까요?" description="링크가 비활성화됩니다. 내 계정의 원래 대화는 유지됩니다." busy={busy} confirmLabel="공유 취소" onConfirm={async () => { if (!deleting) return; setBusy(true); try { await request(`shares/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' }); setShares((old) => old?.filter((share) => share.id !== deleting.id) || []); setDeleting(null); onNotice?.('공개 링크를 취소했습니다.'); } catch (cause) { setError(cause instanceof Error ? cause.message : '공유를 취소하지 못했습니다.'); setDeleting(null); } finally { setBusy(false); } }} />
  </>;
}

function SharedConversationPage({ token }: { token: string }) {
  const [shared, setShared] = useState<{ title: string; messages: { role: string; content: string; model?: string }[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setShared(null);
    setError('');
    request<{ title: string; messages: { role: string; content: string; model?: string }[] }>(`public-shares/${encodeURIComponent(token)}`, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setShared(data); }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '공유한 대화를 불러오지 못했습니다.'); });
    return () => controller.abort();
  }, [token]);
  if (error) return <section className="prism-setting-card prism-capability-state"><Link2 size={28} /><h2>이 링크를 열 수 없습니다</h2><p role="alert">{error}</p></section>;
  if (!shared) return <p className="prism-setting-status" role="status"><LoaderCircle className="spin" size={18} />공유한 대화 불러오는 중…</p>;
  return <><div className="prism-settings-page-head"><h1>{shared.title}</h1><p>Prism에서 공유한 대화 사본</p></div>{shared.messages.map((message, index) => <article className="prism-shared-message" key={index}><h2>{message.role === 'user' ? '사용자' : message.model || 'AI'}</h2><pre>{message.content}</pre></article>)}</>;
}

function FeedbackPage() {
  const [text, setText] = useState('');
  const issueUrl = `https://github.com/JackRo682/open-prism/issues/new?${new URLSearchParams({ title: 'Prism 사용 의견', body: text })}`;
  return <section className="prism-setting-card"><h2>어떤 점을 개선하면 좋을까요?</h2><label className="prism-settings-field" htmlFor="prism-feedback">의견<textarea id="prism-feedback" value={text} maxLength={5000} onChange={(event) => setText(event.target.value)} placeholder="발생한 문제나 원하는 개선 사항을 적어 주세요." /></label><p>GitHub의 새 이슈 화면에서 내용을 검토하고 직접 제출할 수 있습니다.</p><div className="prism-setting-actions">{text.trim() ? <a className="prism-action-button primary" href={issueUrl} target="_blank" rel="noreferrer">GitHub에서 검토 <ArrowUpRight size={15} /></a> : <button className="prism-action-button primary" disabled>GitHub에서 검토 <ArrowUpRight size={15} /></button>}</div></section>;
}

export function UnavailableFeaturePage({ feature, onNavigate }: { feature: 'images' | 'videos' | 'scheduled'; onNavigate: (path: string) => void }) {
  const content = {
    images: { icon: Image, title: '이미지 생성은 아직 연결되지 않았습니다', text: '현재 연결된 AI 요청은 텍스트를 처리합니다. 이미지 생성 모델과 결과 파일 저장 기능을 연결한 뒤 사용할 수 있습니다.' },
    videos: { icon: Video, title: '동영상 생성은 아직 연결되지 않았습니다', text: '동영상 생성 서비스와 작업 상태 확인 기능이 연결되어 있지 않습니다.' },
    scheduled: { icon: Clock3, title: '예약 작업은 아직 연결되지 않았습니다', text: '현재 대화에서 요청과 답변을 주고받을 수 있습니다. 예약 실행 서버가 연결되면 이곳에서 작업을 관리할 수 있습니다.' },
  }[feature];
  return <section className="prism-setting-card prism-capability-state"><content.icon size={32} /><span className="prism-status-pill">연결 안 됨</span><h2>{content.title}</h2><p>{content.text}</p><div className="prism-feature-links"><button className="prism-action-button primary" onClick={() => onNavigate('/chat')}>채팅으로 이동</button><button className="prism-action-button" onClick={() => onNavigate('/settings')}>AI 연결 상태 확인</button></div></section>;
}

export function SettingsPages(props: SettingsPagesProps) {
  const { pathname, signedIn, onNavigate } = props;
  if (pathname === '/browser-settings') return <BrowserSettingsPage signedIn={signedIn} onNotice={props.onNotice} />;
  const [title, description] = pageTitles[pathname] || ['공유한 대화', ''];
  const needsAccount = ['/personalization-settings', '/gemini-spark', '/customize/skills', '/import', '/sharing'].includes(pathname);
  let page: ReactNode;
  if (needsAccount && !signedIn) page = <SignInCard pathname={pathname} />;
  else if (pathname === '/personalization-settings') page = <PersonalizationPage onNavigate={onNavigate} onNotice={props.onNotice} />;
  else if (pathname === '/gemini-spark') page = <WorkPage onNotice={props.onNotice} />;
  else if (pathname === '/customize/skills') page = <SkillsPage onNotice={props.onNotice} />;
  else if (pathname === '/gems/view') page = <section className="prism-setting-card prism-capability-state"><Diamond size={32} /><h2>맞춤 지침은 스킬에서 관리하세요</h2><p>저장한 스킬을 대화에 불러와 원하는 답변 방식을 적용할 수 있습니다.</p><button className="prism-action-button primary" onClick={() => onNavigate('/customize/skills')}>스킬로 이동 <ChevronRight size={15} /></button></section>;
  else if (pathname === '/import') page = <ImportPage onNotice={props.onNotice} />;
  else if (pathname === '/sharing') page = <SharingPage onNavigate={onNavigate} onNotice={props.onNotice} />;
  else if (pathname === '/feedback') page = <FeedbackPage />;
  else if (pathname === '/images' || pathname === '/videos' || pathname === '/scheduled') page = <UnavailableFeaturePage feature={pathname.slice(1) as 'images' | 'videos' | 'scheduled'} onNavigate={onNavigate} />;
  else if (pathname.startsWith('/share/')) page = <SharedConversationPage token={pathname.slice(7)} />;
  else return null;
  return <div className="prism-settings-page" key={pathname}><button className="prism-back-button" onClick={() => onNavigate('/chat')}><ArrowLeft size={17} />채팅으로 돌아가기</button>{!pathname.startsWith('/share/') && <div className="prism-settings-page-head"><h1>{title}</h1><p>{description}</p></div>}{page}</div>;
}
