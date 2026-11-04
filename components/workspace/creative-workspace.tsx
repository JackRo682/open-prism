'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { Check, ChevronDown, Copy, Download, Film, Image, Info, LoaderCircle, Maximize2, PenLine, Play, Save, Sparkles, Video, X } from 'lucide-react';

export type CanvasDraft = { text: string; saved: boolean };

/** User-editable content starts from the actual assistant response. */
export function CanvasPanel({ text, draft: editedDraft, onDraftChange, busy, onRevise, onSave, onError }: {
  draft?: CanvasDraft; onDraftChange(draft: CanvasDraft | null): void;
  text: string; busy: boolean; onRevise(text: string): void;
  onSave(text: string): Promise<void>; onError(message: string): void;
}) {
  const draft = editedDraft?.text ?? text;
  const dirty = !!editedDraft;
  const saved = editedDraft?.saved ?? false;
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const content = <>
    <div className="prism-canvas-toolbar"><span><PenLine size={18}/>Canvas</span><div><button aria-label={expanded ? 'Canvas 축소' : 'Canvas 확대'} onClick={() => setExpanded(value => !value)}>{expanded ? <X size={17}/> : <Maximize2 size={17}/>}</button></div></div>
    <label className="prism-visually-hidden" htmlFor={expanded ? 'canvas-editor-expanded' : 'canvas-editor'}>Canvas 문서 편집</label>
    <textarea id={expanded ? 'canvas-editor-expanded' : 'canvas-editor'} className="prism-canvas-editor" value={draft} maxLength={100000} spellCheck={false} readOnly={busy || saving} placeholder={busy ? '답변이 여기에 작성됩니다…' : '함께 작성할 내용을 입력하세요.'} onChange={event => { onDraftChange({text:event.target.value,saved:false}); setCopied(false); }}/>
    {dirty && text !== draft && <button className="prism-canvas-sync" disabled={busy || saving} onClick={() => { onDraftChange(null); setCopied(false); }}>최신 AI 답변으로 바꾸기</button>}
    <div className="prism-canvas-status" aria-live="polite">{busy ? 'AI가 작성 중입니다…' : saving ? '문서를 저장 중입니다…' : saved ? '파일에 저장되었습니다.' : '수정한 초안은 이 탭에 보관됩니다. 파일로 보관하려면 저장하세요.'}</div>
    <div className="prism-canvas-actions">
      <button disabled={!draft || busy || saving} onClick={() => onRevise(draft)}><Sparkles size={15}/>이 초안으로 계속</button>
      <button aria-label="Canvas 복사" disabled={!draft} onClick={async () => { try { await navigator.clipboard.writeText(draft); setCopied(true); } catch { onError('클립보드에 접근할 수 없습니다. 내용을 직접 선택해 복사해 주세요.'); } }}>{copied ? <Check size={16}/> : <Copy size={16}/>}</button>
      <button aria-label="Canvas 다운로드" disabled={!draft} onClick={() => { const url = URL.createObjectURL(new Blob([draft], {type:'text/markdown;charset=utf-8'})); const link = document.createElement('a'); link.href = url; link.download = 'prism-canvas.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}><Download size={16}/></button>
      <button disabled={!draft || saving || busy} onClick={async () => { const snapshot = draft; setSaving(true); try { await onSave(snapshot); onDraftChange({text:snapshot,saved:true}); } catch (cause) { onError(cause instanceof Error ? cause.message : '문서를 저장하지 못했습니다.'); } finally { setSaving(false); } }}>{saving ? <LoaderCircle className="spin" size={16}/> : saved ? <Check size={16}/> : <Save size={16}/>}저장</button>
    </div>
  </>;
  return <>
    {!expanded && <aside className="prism-canvas-panel" aria-label="Canvas 문서">{content}</aside>}
    <Dialog.Root open={expanded} onOpenChange={setExpanded}><Dialog.Portal><Dialog.Overlay className="prism-dialog-overlay"/><Dialog.Content className="prism-canvas-dialog" aria-describedby={undefined}><Dialog.Title className="prism-visually-hidden">Canvas 문서 편집</Dialog.Title>{content}</Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}

/** The film frames are decorative illustrations, never fabricated user results. */
function FilmIllustration() {
  return <div className="prism-film-illustration" aria-hidden="true">
    <div className="prism-film-frame landscape"><span className="film-sun"/><span className="film-mountain one"/><span className="film-mountain two"/></div>
    <div className="prism-film-frame flower"><span/><span/><span/><span/><i/></div>
    <div className="prism-film-frame abstract"><i/><i/><i/></div>
    <div className="prism-film-frame ocean"><span/><span/><span/></div>
    <span className="prism-film-play"><Play size={20} fill="currentColor"/></span>
  </div>;
}

export function MediaWorkspace({ kind, composer, onNavigate, onFocus }: {
  kind: 'image'|'video'; composer: ReactNode; onNavigate(path: string): void; onFocus(): void;
}) {
  const [intro, setIntro] = useState(false);
  const video = kind === 'video';
  useEffect(() => {
    if (!video) return;
    try { if (localStorage.getItem('prism-video-intro-seen') !== '1') setIntro(true); }
    catch { setIntro(true); }
  }, [video]);
  const dismissIntro = () => {
    try { localStorage.setItem('prism-video-intro-seen','1'); } catch {}
    setIntro(false);
  };
  return <section className={'prism-media-workspace ' + kind}>
    <div className="prism-media-heading"><h1>{video ? '동영상' : '이미지'}<ChevronDown size={16}/></h1>{video && <button aria-label="동영상 소개 열기" onClick={() => setIntro(true)}><Info size={18}/></button>}</div>
    <div className="prism-media-center">
      <div className="prism-media-empty"><span className="prism-media-empty-icon">{video ? <Film size={26}/> : <Image size={26}/>}</span><h2>{video ? '어떤 장면을 만들고 싶으세요?' : '상상하는 이미지를 설명해 보세요.'}</h2><p>{video ? '분위기, 움직임, 장면을 구체적으로 적어 보세요.' : '주제, 스타일, 구도를 담아 프롬프트를 준비하세요.'}</p></div>
      <div className="prism-media-composer">{composer}</div>
      <div className="prism-media-availability"><span>생성 서비스 연결 필요</span><p>{video ? '동영상 생성 서비스가 아직 연결되지 않았습니다.' : '이미지 생성 서비스가 아직 연결되지 않았습니다.'} 연결 후 결과를 이곳에서 확인할 수 있습니다.</p><button onClick={() => onNavigate('/settings')}>AI 연결 상태 확인</button></div>
    </div>
    <Dialog.Root open={intro} onOpenChange={open => open ? setIntro(true) : dismissIntro()}><Dialog.Portal><Dialog.Overlay className="prism-dialog-overlay"/><Dialog.Content className="prism-video-intro" onCloseAutoFocus={event => { event.preventDefault(); onFocus(); }}>
      <Dialog.Close className="prism-video-intro-close" aria-label="동영상 소개 닫기"><X size={19}/></Dialog.Close>
      <FilmIllustration/>
      <div className="prism-video-intro-body"><Dialog.Title>동영상 만들기</Dialog.Title><Dialog.Description>아이디어가 장면이 되는 작업 공간</Dialog.Description>
        <ul><li><Video size={22}/><span><strong>나만의 장면 구상하기</strong><small>만들고 싶은 영상의 내용을 자유롭게 적어 보세요.</small></span></li><li><Image size={22}/><span><strong>구도와 분위기 정하기</strong><small>가로·세로 비율과 표현할 스타일을 준비하세요.</small></span></li><li><Sparkles size={22}/><span><strong>생성 서비스 연결 후 시작하기</strong><small>현재는 프롬프트를 준비할 수 있습니다. 실제 생성 기능은 연결이 필요합니다.</small></span></li></ul>
        <button className="prism-video-intro-start" onClick={dismissIntro}>프롬프트 작성하기</button>
      </div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
