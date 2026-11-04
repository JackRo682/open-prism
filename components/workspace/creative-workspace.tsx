'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { AlertCircle, Check, Copy, Download, Film, Image, Info, LoaderCircle, Maximize2, PenLine, Play, Save, Sparkles, Video, X } from 'lucide-react';

export type CanvasDraft = { text: string; saved: boolean };
export type MediaResult = { id: string; url: string; mimeType: string; prompt?: string };

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

export function MediaWorkspace({ kind, composer, onNavigate, onFocus, configured = false, busy = false, results = [], error, pendingLabel }: {
  kind: 'image'|'video'; composer: ReactNode; onNavigate(path: string): void; onFocus(): void;
  configured?: boolean; busy?: boolean; results?: MediaResult[]; error?: string; pendingLabel?: string;
}) {
  const [intro, setIntro] = useState(false);
  const [failedMedia, setFailedMedia] = useState<Record<string, boolean>>({});
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
    <div className="prism-media-heading"><h1>{video ? '동영상' : '이미지'}</h1>{video && <button type="button" aria-label="동영상 소개 열기" onClick={() => setIntro(true)}><Info size={18}/></button>}</div>
    <div className="prism-media-center" data-has-results={results.length > 0}>
      {results.length === 0 && !busy && <div className="prism-media-empty"><span className="prism-media-empty-icon">{video ? <Film size={26}/> : <Image size={26}/>}</span><h2>{video ? '어떤 장면을 만들고 싶으세요?' : '상상하는 이미지를 설명해 보세요.'}</h2><p>{video ? '분위기, 움직임, 장면을 구체적으로 적어 보세요.' : '주제, 스타일, 구도를 담아 프롬프트를 작성하세요.'}</p></div>}
      {results.length > 0 && <div className="prism-media-results" aria-label={video ? '생성한 동영상' : '생성한 이미지'}>
        {results.map((result, index) => <figure className="prism-media-result" key={result.id}>
          {failedMedia[result.id] ? <p className="prism-media-load-error" role="alert">미리보기를 불러오지 못했습니다. 아래 다운로드로 파일을 확인해 주세요.</p>
            : result.mimeType.startsWith('video/') ? <video src={result.url} controls playsInline preload="metadata" aria-label={result.prompt || `생성한 동영상 ${index + 1}`} onError={() => setFailedMedia(current => ({ ...current, [result.id]: true }))} />
            : result.mimeType.startsWith('image/') ? <img src={result.url} alt={result.prompt || `생성한 이미지 ${index + 1}`} loading="lazy" onError={() => setFailedMedia(current => ({ ...current, [result.id]: true }))} />
            : <p className="prism-media-load-error">이 파일은 다운로드해서 확인할 수 있습니다.</p>}
          <figcaption>
            <span>{result.prompt || `${video ? '동영상' : '이미지'} ${index + 1}`}</span>
            <a href={result.url} download aria-label={`${video ? '동영상' : '이미지'} ${index + 1} 다운로드`}><Download size={17} aria-hidden="true" /><span>다운로드</span></a>
          </figcaption>
        </figure>)}
      </div>}
      {busy && <div className="prism-media-progress" role="status" aria-live="polite"><LoaderCircle className="spin" size={22} aria-hidden="true" /><span>{pendingLabel || (video ? '동영상을 생성하고 있습니다…' : '이미지를 생성하고 있습니다…')}</span></div>}
      {error && <div className="prism-media-error" role="alert"><AlertCircle size={20} aria-hidden="true" /><p>{error}</p></div>}
      <div className="prism-media-composer">{composer}</div>
      {!configured && <div className="prism-media-availability"><span>{video ? '서비스 연결 · 동영상 이용 한도 설정 필요' : '생성 서비스 이용 설정 필요'}</span><p>{video ? '동영상 생성에는 Google API 연결과 운영자가 승인한 동영상 이용 한도가 필요합니다. 기본 무료 체험 한도는 동영상 생성에 부족합니다.' : '이미지 생성 서비스 연결과 이용 설정을 확인하면 결과를 이곳에서 볼 수 있습니다.'}</p><button type="button" onClick={() => onNavigate('/settings')}>AI 연결 상태 확인</button></div>}
    </div>
    <Dialog.Root open={intro} onOpenChange={open => open ? setIntro(true) : dismissIntro()}><Dialog.Portal><Dialog.Overlay className="prism-dialog-overlay"/><Dialog.Content className="prism-video-intro" onCloseAutoFocus={event => { event.preventDefault(); onFocus(); }}>
      <Dialog.Close className="prism-video-intro-close" aria-label="동영상 소개 닫기"><X size={19}/></Dialog.Close>
      <FilmIllustration/>
      <div className="prism-video-intro-body"><Dialog.Title>동영상 만들기</Dialog.Title><Dialog.Description>아이디어가 장면이 되는 작업 공간</Dialog.Description>
        <ul><li><Video size={22}/><span><strong>나만의 장면 구상하기</strong><small>만들고 싶은 영상의 내용을 자유롭게 적어 보세요.</small></span></li><li><Image size={22}/><span><strong>구도와 분위기 정하기</strong><small>참조 이미지와 가로·세로 비율을 선택할 수 있습니다.</small></span></li><li><Sparkles size={22}/><span><strong>{configured ? '결과를 확인하고 다운로드하기' : '서비스 연결과 이용 한도 확인하기'}</strong><small>{configured ? '완성된 동영상을 이 화면에서 재생하고 저장하세요.' : 'Google API 연결과 운영자의 동영상 이용 한도 승인이 필요합니다.'}</small></span></li></ul>
        <button type="button" className="prism-video-intro-start" onClick={dismissIntro}>프롬프트 작성하기</button>
      </div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
