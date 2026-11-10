'use client';

import './workspace-features.css';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AlertDialog } from 'radix-ui';
import { AlertCircle, ArrowLeft, ArrowUpRight, Check, Copy, Download, FileText, LoaderCircle, NotebookPen, Paperclip, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react';

export type NotebookFile = { id: string; name: string; size: number; created_at: number };
export type NotebookPageProps = {
  signedIn: boolean;
  onNavigate(path: string): void;
  onAttach(id: string): void;
  onFilesChanged?(): void | Promise<void>;
};
const MAX_BYTES = 131_072;
const NOTEBOOK_MARKER = '<!-- prism:notebook:v1 -->';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api/' + path, options);
  let body: T & { error?: string };
  try { body = await response.json(); } catch { throw new Error('서버 응답을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
  if (!response.ok) throw new Error(body.error || '요청을 처리하지 못했습니다.');
  return body;
}
async function fileText(id: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch('/api/files/' + encodeURIComponent(id), { signal });
  if (!response.ok) {
    let message = '문서를 읽지 못했습니다. 파일이 삭제되었는지 확인해 주세요.';
    try { const body = await response.json() as { error?: unknown }; if (typeof body.error === 'string') message = body.error; } catch {}
    throw new Error(message);
  }
  return response.text();
}
function titleOf(file: NotebookFile) { return file.name.replace(/\.md$/i, ''); }
function cleanNotebookText(text: string) { return text.replace(NOTEBOOK_MARKER + '\n', '').replace(/^# [^\n]*\n{1,2}/, ''); }
function displayBytes(bytes: number) { return bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB'; }

export function NotebookPage({ signedIn, onNavigate, onAttach, onFilesChanged }: NotebookPageProps) {
  const [files, setFiles] = useState<NotebookFile[]>([]), [loading, setLoading] = useState(signedIn);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [search, setSearch] = useState('');
  const [title, setTitle] = useState(''), [content, setContent] = useState(''), [sources, setSources] = useState<string[]>([]);
  const [selected, setSelected] = useState<NotebookFile | null>(null), [preview, setPreview] = useState(''), [previewLoading, setPreviewLoading] = useState(false), [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false), [deleting, setDeleting] = useState<NotebookFile | null>(null), [deleteBusy, setDeleteBusy] = useState(false), [refreshKey, setRefreshKey] = useState(0);
  const prefix = useId(), titleRef = useRef<HTMLInputElement>(null), mounted = useRef(true), saveAbort = useRef<AbortController | null>(null);
  const restoredDraft = useRef(false);
  function rememberNotebook() {
    if (!title.trim() && !content.trim()) return;
    try { sessionStorage.setItem('prism-notebook-signin-draft:v1', JSON.stringify({ title, content, savedAt: Date.now() })); } catch {}
  }
  useEffect(() => {
    try {
      if (!restoredDraft.current) {
        restoredDraft.current = true;
        const saved = JSON.parse(sessionStorage.getItem('prism-notebook-signin-draft:v1') || 'null'), age = Date.now() - saved?.savedAt;
        if (saved && Number.isFinite(age) && age >= 0 && age < 3_600_000 && typeof saved.title === 'string' && saved.title.length <= 100 && typeof saved.content === 'string' && saved.content.length <= 100000) {
          setTitle(saved.title); setContent(saved.content);
        }
      }
      if (signedIn) sessionStorage.removeItem('prism-notebook-signin-draft:v1');
    } catch {}
  }, [signedIn]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; saveAbort.current?.abort(); }; }, []);
  useEffect(() => {
    if (!signedIn) { setLoading(false); setFiles([]); setSelected(null); setPreview(''); return; }
    const controller = new AbortController(); setLoading(true); setError('');
    request<NotebookFile[]>('files', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setFiles(result); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '노트북을 불러오지 못했습니다.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [signedIn, refreshKey]);
  useEffect(() => {
    setPreview(''); setPreviewError('');
    if (!selected || !signedIn) { setPreviewLoading(false); return; }
    const controller = new AbortController(); setPreviewLoading(true);
    fileText(selected.id, controller.signal)
      .then(text => { if (!controller.signal.aborted) setPreview(text); })
      .catch(cause => { if (!controller.signal.aborted) setPreviewError(cause instanceof Error ? cause.message : '문서를 읽지 못했습니다.'); })
      .finally(() => { if (!controller.signal.aborted) setPreviewLoading(false); });
    return () => controller.abort();
  }, [selected?.id, signedIn, refreshKey]);

  const notebooks = files.filter(file => /\.md$/i.test(file.name));
  const visible = notebooks.filter(file => file.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const draftBytes = new TextEncoder().encode(NOTEBOOK_MARKER + '\n# ' + title.trim() + '\n\n' + content).length;
  function startNew() { setSelected(null); setError(''); setNotice(''); requestAnimationFrame(() => titleRef.current?.focus()); }
  function attach(file: NotebookFile) { onAttach(file.id); onNavigate('/chat'); }

  async function save(attachAfter: boolean) {
    if (saving || !signedIn || !title.trim()) return;
    if (draftBytes > MAX_BYTES) { setError('노트북은 참고 자료를 포함해 128 KB까지 저장할 수 있습니다. 내용을 줄여 주세요.'); return; }
    const controller = new AbortController(); saveAbort.current = controller;
    setSaving(true); setError(''); setNotice('');
    try {
      const selectedSources = sources.map(id => files.find(file => file.id === id));
      if (selectedSources.some(file => !file)) throw new Error('선택한 참고 자료가 없습니다. 자료를 다시 선택해 주세요.');
      const texts = await Promise.all(selectedSources.map(file => fileText(file!.id, controller.signal)));
      const appendix = texts.length ? '\n\n## 참고 자료\n\n' + texts.map((text, index) => '### ' + selectedSources[index]!.name.replace(/[\r\n]/g, ' ') + '\n\n' + text).join('\n\n---\n\n') : '';
      const body = `${NOTEBOOK_MARKER}\n# ${title.trim()}\n\n${content.trim()}${appendix}\n`;
      if (new TextEncoder().encode(body).length > MAX_BYTES) throw new Error('참고 자료를 합친 노트북이 128 KB를 넘습니다. 자료를 줄이거나 노트를 나눠 주세요.');
      const baseName = title.trim().replace(/\.md$/i, '').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-').replace(/[. ]+$/g, '').slice(0, 100) || '노트북';
      const file = new File([body], baseName + '.md', { type: 'text/markdown' }), payload = new FormData(); payload.set('file', file);
      const result = await request<{ id: string; name: string; size: number }>('files', { method: 'POST', body: payload, signal: controller.signal });
      if (!mounted.current) return;
      const stored: NotebookFile = { ...result, created_at: Date.now() };
      setFiles(previous => [stored, ...previous]); setSelected(stored); setPreview(body);
      setTitle(''); setContent(''); setSources([]); setNotice('노트북을 저장했습니다.');
      // Refresh the shared sidebar, while keeping a successful save successful
      // even if that independent refresh fails.
      try { await onFilesChanged?.(); } catch {}
      if (attachAfter && mounted.current) attach(stored);
    } catch (cause) { if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '노트북을 저장하지 못했습니다.'); }
    finally { if (mounted.current) setSaving(false); saveAbort.current = null; }
  }
  async function remove(file: NotebookFile) {
    setDeleteBusy(true); setError(''); setNotice('');
    try {
      await request('files/' + file.id, { method: 'DELETE' });
      if (!mounted.current) return;
      setFiles(previous => previous.filter(item => item.id !== file.id)); setSources(previous => previous.filter(id => id !== file.id));
      if (selected?.id === file.id) setSelected(null);
      setDeleting(null); setNotice('노트북을 삭제했습니다.');
      try { await onFilesChanged?.(); } catch {}
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '노트북을 삭제하지 못했습니다.'); }
    finally { if (mounted.current) setDeleteBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void save(false); }

  return <section className="prism-feature-page prism-notebook-page" aria-labelledby={prefix + '-heading'}>
    <div className="prism-feature-heading"><button className="prism-feature-back" onClick={() => onNavigate('/chat')} aria-label="채팅으로 돌아가기"><ArrowLeft size={20}/></button><div><h1 id={prefix + '-heading'}>노트북</h1><p>생각과 참고 자료를 한 문서에 모아 대화에 활용하세요.</p></div><button className="prism-feature-button primary" disabled={saving} onClick={startNew}><Plus size={18}/>새 노트북</button></div>
    {!signedIn && <div className="prism-feature-notice"><NotebookPen size={20}/><div><strong>로그인하고 노트북을 저장하세요.</strong><p>노트북과 참고 자료는 내 계정에서만 확인할 수 있습니다.</p><a className="prism-feature-button primary" href="/signin-with-chatgpt?return_to=%2Fnotebooks" target="_top" onClick={rememberNotebook}>ChatGPT로 로그인<ArrowUpRight size={16}/></a></div></div>}
    {error && <p className="prism-feature-status error" role="alert"><AlertCircle size={18}/>{error}</p>}
    {notice && <p className="prism-feature-status success" role="status"><Check size={18}/>{notice}</p>}
    <div className="prism-notebook-layout">
      <aside className="prism-notebook-library" aria-label="저장한 노트북">
        <div className="prism-feature-section-heading"><h2>내 노트북 <span className="prism-feature-count">{notebooks.length}</span></h2><button className="prism-feature-icon" aria-label="노트북 새로고침" disabled={!signedIn || loading || saving || deleteBusy} onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={17} className={loading ? 'spin' : ''}/></button></div>
        <label className="prism-notebook-search"><Search size={17}/><span className="prism-visually-hidden">노트북 검색</span><input type="search" placeholder="노트북 검색" value={search} onChange={event => setSearch(event.target.value)}/></label>
        {loading && <p className="prism-feature-status" role="status"><LoaderCircle size={17} className="spin"/>불러오는 중…</p>}
        {!loading && !visible.length && <p className="prism-notebook-empty">{search ? '검색 결과가 없습니다.' : signedIn ? '첫 노트북을 만들어 보세요.' : '로그인하면 저장한 노트북이 표시됩니다.'}</p>}
        <div className="prism-notebook-list">{visible.map(file => <button className={'prism-notebook-list-item ' + (selected?.id === file.id ? 'selected' : '')} key={file.id} aria-pressed={selected?.id === file.id} disabled={saving || deleteBusy} onClick={() => { setSelected(file); setNotice(''); }}><NotebookPen size={20}/><span><strong>{titleOf(file)}</strong><small>{displayBytes(file.size)} · {new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(file.created_at)}</small></span></button>)}</div>
      </aside>

      {selected ? <article className="prism-feature-card prism-notebook-editor">
        <div className="prism-feature-section-heading"><div><span className="prism-feature-eyebrow">저장된 문서</span><h2>{titleOf(selected)}</h2></div><button className="prism-feature-icon danger" aria-label={titleOf(selected) + ' 삭제'} disabled={deleteBusy || saving} onClick={() => { setError(''); setDeleting(selected); }}><Trash2 size={18}/></button></div>
        {previewLoading ? <p className="prism-feature-status" role="status"><LoaderCircle size={18} className="spin"/>문서를 읽는 중…</p> : previewError ? <div className="prism-feature-status error" role="alert"><AlertCircle size={18}/><span>{previewError}</span><button className="prism-feature-link" onClick={() => setRefreshKey(value => value + 1)}>다시 시도</button></div> : <pre className="prism-notebook-preview" tabIndex={0}>{cleanNotebookText(preview) || '내용이 없는 노트북입니다.'}</pre>}
        <div className="prism-feature-form-actions notebook"><button className="prism-feature-button" disabled={previewLoading || !!previewError} onClick={() => { setTitle(titleOf(selected) + ' 사본'); setContent(cleanNotebookText(preview)); setSources([]); startNew(); }}><Copy size={16}/>복사해서 편집</button><a className="prism-feature-button" href={'/api/files/' + selected.id} download={selected.name}><Download size={16}/>다운로드</a><button className="prism-feature-button primary" disabled={previewLoading || !!previewError} onClick={() => attach(selected)}><Paperclip size={16}/>채팅에 첨부</button></div>
      </article> : <form className="prism-feature-card prism-notebook-editor" onSubmit={submit}>
        <div className="prism-feature-section-heading"><div><span className="prism-feature-eyebrow">새 문서</span><h2>새 노트북 만들기</h2></div><NotebookPen size={22}/></div>
        <label className="prism-feature-field" htmlFor={prefix + '-title'}><span>노트북 이름</span><input ref={titleRef} id={prefix + '-title'} required maxLength={100} placeholder="예: 프로젝트 아이디어" value={title} disabled={saving} onChange={event => setTitle(event.target.value)}/></label>
        <label className="prism-feature-field" htmlFor={prefix + '-content'}><span>노트</span><textarea id={prefix + '-content'} rows={12} maxLength={100000} placeholder="아이디어, 메모, 정리할 내용을 적어 주세요. Markdown을 사용할 수 있습니다." value={content} disabled={saving} onChange={event => setContent(event.target.value)}/><small className={draftBytes > MAX_BYTES ? 'error' : ''}>{displayBytes(draftBytes)} / 128 KB · 참고 자료를 포함한 전체 크기 기준</small></label>
        {signedIn && files.length > 0 && <fieldset className="prism-notebook-sources" disabled={saving}><legend><FileText size={16}/>참고 자료 추가 <span>{sources.length} / 3</span></legend><p>선택한 문서의 현재 내용을 노트북에 함께 저장합니다.</p><div>{files.map(file => <label className="prism-feature-check" key={file.id}><input type="checkbox" checked={sources.includes(file.id)} disabled={!sources.includes(file.id) && sources.length >= 3} onChange={event => setSources(previous => event.target.checked ? [...previous, file.id] : previous.filter(id => id !== file.id))}/><span>{file.name}<small>{displayBytes(file.size)}</small></span></label>)}</div></fieldset>}
        <div className="prism-feature-form-actions notebook">{signedIn ? <><button className="prism-feature-button" type="submit" disabled={saving || !title.trim() || draftBytes > MAX_BYTES}>{saving ? <LoaderCircle className="spin" size={16}/> : <Save size={16}/>}저장</button><button className="prism-feature-button primary" type="button" disabled={saving || !title.trim() || draftBytes > MAX_BYTES} onClick={() => save(true)}><Paperclip size={16}/>저장 후 채팅에 첨부</button></> : <a className="prism-feature-button primary" href="/signin-with-chatgpt?return_to=%2Fnotebooks" target="_top" onClick={rememberNotebook}>로그인하고 저장<ArrowUpRight size={16}/></a>}</div>
      </form>}
    </div>
    <AlertDialog.Root open={!!deleting} onOpenChange={open => { if (!open && !deleteBusy) setDeleting(null); }}><AlertDialog.Portal><AlertDialog.Overlay className="prism-dialog-overlay"/><AlertDialog.Content className="prism-dialog-content prism-feature-confirm"><AlertDialog.Title>노트북을 삭제할까요?</AlertDialog.Title><AlertDialog.Description>“{deleting && titleOf(deleting)}” 파일을 삭제합니다. 필요한 내용은 먼저 다운로드해 주세요.</AlertDialog.Description>{error && <p className="prism-feature-status error" role="alert">{error}</p>}<div className="prism-feature-form-actions"><AlertDialog.Cancel className="prism-feature-button" disabled={deleteBusy}>취소</AlertDialog.Cancel><button className="prism-feature-button danger" disabled={deleteBusy} onClick={() => deleting && remove(deleting)}>{deleteBusy && <LoaderCircle className="spin" size={16}/>}삭제</button></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
  </section>;
}
