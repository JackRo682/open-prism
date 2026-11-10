'use client';

import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Dialog, DropdownMenu, Popover } from 'radix-ui';
import {
  ArrowUp, Atom, BookOpen, Check, ChevronDown, ChevronRight, Cloud,
  FileText, FolderOpen, Globe2, Image, ImagePlus, LoaderCircle, LockKeyhole, Mic,
  MoreHorizontal, Music2, PanelsTopLeft, Paperclip, Plus, PlugZap,
  RectangleHorizontal, RectangleVertical, ScrollText, Search,
  SlidersHorizontal, Square, Upload, Video, X, type LucideIcon,
} from 'lucide-react';
import type { Model, Provider } from '../../lib/models';
import { isFreeModel } from '../../lib/models';
import { useIsMobile } from '../../hooks/use-mobile';

export type ComposerTool = 'chat' | 'canvas' | 'research' | 'learning' | 'image' | 'video';
export type ComposerResearchSources = { web: boolean };
export type ComposerCapabilities = {
  webResearch: boolean; image: boolean; video: boolean;
  drive?: boolean; music?: boolean;
};
export type VideoAspect = '16:9' | '9:16';
export type MediaReference = { name: string; url?: string };

type FileItem = { id: string; name: string };
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

const toolDetails: Record<Exclude<ComposerTool, 'chat'>, { label: string; placeholder: string; icon: LucideIcon }> = {
  canvas: { label: 'Canvas', placeholder: '함께 작성하거나 만들어 봐요', icon: PanelsTopLeft },
  research: { label: 'Deep Research', placeholder: '무엇을 조사하고 싶으신가요?', icon: Atom },
  learning: { label: '학습', placeholder: '무엇을 배우고 싶으신가요?', icon: BookOpen },
  image: { label: '이미지', placeholder: '만들고 싶은 이미지를 설명하세요.', icon: Image },
  video: { label: '동영상', placeholder: '동영상을 설명하세요.', icon: Video },
};
const noCapabilities: ComposerCapabilities = { webResearch: false, image: false, video: false };
const imageNoticeKey = 'prism-image-notice-v1';

export type ComposerProps = {
  prompt: string; onPrompt(value: string): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  models: Model[]; selected: Model; onModel(model: Model): void;
  providers: Record<Provider, { configured: boolean }>;
  effort: string; onEffort(value: string): void;
  pro?: boolean; onPro?(value:boolean):void;
  mode: 'chat' | 'work'; compare?: boolean;
  tool?: ComposerTool; onTool?(tool: ComposerTool): void;
  researchSources?: ComposerResearchSources;
  onResearchSources?(sources: ComposerResearchSources): void;
  capabilities?: ComposerCapabilities;
  videoAspect?: VideoAspect; onVideoAspect?(aspect: VideoAspect): void;
  onMediaUpload?(): void;
  mediaReference?: MediaReference | null;
  onRemoveMediaReference?(): void;
  onDriveUpload?(): void;
  onMusic?(): void;
  mediaModelLabel?: string;
  showCapabilityNotice?: boolean;
  busy: boolean; ready: boolean; uploading: boolean;
  files: FileItem[]; attached: string[];
  onAttach(id: string): void; onDetach(id: string): void; onUpload(): void;
  onSend(): void; onStop(): void; onNavigate(path: string): void;
  onError(message: string): void;
  signedIn: boolean;
  walletBalance?: number | null;
  selectedSkill: { id: string; name: string } | null;
  onSkill(skill: { id: string; name: string } | null): void;
};

function SavedFileItems({ files, attached, onAttach, onDetach, onSelect }: {
  files: FileItem[]; attached: string[];
  onAttach(id: string): void; onDetach(id: string): void; onSelect(): void;
}) {
  if (!files.length) return <DropdownMenu.Label className="prism-tool-note">저장된 파일이 없습니다.</DropdownMenu.Label>;
  return <>
    <DropdownMenu.Label className="prism-tool-section-label">저장된 파일</DropdownMenu.Label>
    {files.map(file => <DropdownMenu.CheckboxItem
      key={file.id}
      className="prism-tool-item"
      checked={attached.includes(file.id)}
      onSelect={onSelect}
      onCheckedChange={checked => checked ? onAttach(file.id) : onDetach(file.id)}
    >
      <FileText size={17} aria-hidden="true" /><span>{file.name}</span>
      <DropdownMenu.ItemIndicator className="prism-tool-check"><Check size={16} aria-hidden="true" /></DropdownMenu.ItemIndicator>
    </DropdownMenu.CheckboxItem>)}
  </>;
}

export function Composer(props: ComposerProps) {
  const isMobile = useIsMobile();
  const [modelOpen, setModelOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [localTool, setLocalTool] = useState<ComposerTool>('chat');
  const [localSources, setLocalSources] = useState<ComposerResearchSources>({ web: false });
  const [localAspect, setLocalAspect] = useState<VideoAspect>('16:9');
  const [imageNoticeOpen, setImageNoticeOpen] = useState(false);
  const imageAcknowledgedRef = useRef(false);
  const imageCancelRef = useRef<HTMLButtonElement>(null);
  const focusAfterMenu = useRef<'trigger' | 'composer' | 'dialog'>('trigger');
  const [query, setQuery] = useState('');
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const latestPrompt = useRef(props.prompt);
  latestPrompt.current = props.prompt;
  const mentionRef = useRef<HTMLDivElement>(null);
  const [skills, setSkills] = useState<Array<{ id: string; name: string }>>([]);
  const [skillError, setSkillError] = useState('');
  const [loadingSkills, setLoadingSkills] = useState(false);
  const capabilityNoticeId = useId();
  const webSourceNoticeId = useId();
  const mention = /(?:^|\s)@([^\s@]*)$/.exec(props.prompt);
  const { inputRef, prompt } = props;
  const tool = props.compare ? 'chat' : props.tool ?? localTool;
  const capabilities = props.capabilities ?? noCapabilities;
  const sources = props.researchSources ?? localSources;
  const videoAspect = props.videoAspect ?? localAspect;
  const details = tool === 'chat' ? null : toolDetails[tool];
  const ToolIcon = details?.icon;
  const isMedia = tool === 'image' || tool === 'video';
  const mentionOpen = !!mention && !isMedia;
  const mediaUnavailable = tool === 'image' ? !capabilities.image : tool === 'video' ? !capabilities.video : false;
  const capabilityNotice = mediaUnavailable ? tool === 'video' ? '동영상 생성에는 Google API 연결과 운영자가 승인한 동영상 이용 한도가 필요합니다.' : '이미지 생성 서비스 연결과 이용 설정을 확인해 주세요.' : '';
  const showCapabilityNotice = !!capabilityNotice && props.showCapabilityNotice !== false;
  const expanded = tool !== 'chat' || prompt.includes('\n') || prompt.length > 100;
  const placeholder = props.compare ? '여러 모델에 같은 질문을 입력하세요'
    : details?.placeholder ?? (props.mode === 'work' ? '어떤 작업을 도와드릴까요?' : 'Prism에게 물어보세요');

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = '24px';
    input.style.height = `${Math.min(144, input.scrollHeight)}px`;
  }, [prompt, tool, props.mode, inputRef]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    let width = input.clientWidth;
    const resize = () => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      input.style.height = '24px';
      input.style.height = `${Math.min(144, input.scrollHeight)}px`;
    };
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }
    const observer = new ResizeObserver(resize);
    observer.observe(input);
    return () => observer.disconnect();
  }, [inputRef]);
  useEffect(() => { setModelOpen(false); setSourcesOpen(false); }, [props.mode, tool]);
  useEffect(() => () => recognition.current?.abort(), []);
  useEffect(() => {
    if (!props.busy) return;
    recognition.current?.abort();
    setToolsOpen(false);
    setModelOpen(false);
    setSourcesOpen(false);
  }, [props.busy]);
  useEffect(() => {
    let acknowledged = false;
    try { acknowledged = localStorage.getItem(imageNoticeKey) === 'acknowledged'; } catch { /* Acknowledgement still works for this session. */ }
    imageAcknowledgedRef.current ||= acknowledged;
    if (props.ready && capabilities.image && tool === 'image' && !imageAcknowledgedRef.current) setImageNoticeOpen(true);
  }, [tool, props.ready, capabilities.image]);
  useEffect(() => {
    if (!mentionOpen || !props.signedIn) return;
    const controller = new AbortController();
    setLoadingSkills(true);
    setSkillError('');
    fetch('/api/settings', { signal: controller.signal }).then(async response => {
      const data = await response.json() as { error?: string; skills?: Array<{ id: string; name: string }> };
      if (!response.ok) throw new Error(data.error || '스킬을 불러오지 못했습니다.');
      if (!controller.signal.aborted) setSkills(Array.isArray(data.skills) ? data.skills : []);
    }).catch(error => {
      if (!controller.signal.aborted) setSkillError(error instanceof Error ? error.message : '스킬을 불러오지 못했습니다.');
    }).finally(() => { if (!controller.signal.aborted) setLoadingSkills(false); });
    return () => controller.abort();
  }, [mentionOpen, props.signedIn]);

  function applyTool(next: ComposerTool) {
    if (props.busy) return;
    focusAfterMenu.current = toolsOpen ? 'composer' : 'trigger';
    setMoreToolsOpen(false);
    setToolsOpen(false);
    setSourcesOpen(false);
    if (props.tool === undefined) setLocalTool(next);
    props.onTool?.(next);
    if (next === 'research' && tool !== 'research' && capabilities.webResearch) updateSources(true);
    inputRef.current?.focus();
  }

  function chooseTool(next: ComposerTool) {
    if (next === 'image' && capabilities.image && !imageAcknowledgedRef.current) {
      focusAfterMenu.current = 'dialog';
      setMoreToolsOpen(false);
      setToolsOpen(false);
      setImageNoticeOpen(true);
      return;
    }
    applyTool(next);
  }

  function updateSources(web: boolean) {
    const next = { web: capabilities.webResearch && web };
    if (props.researchSources === undefined) setLocalSources(next);
    props.onResearchSources?.(next);
  }

  function updateAspect(value: string) {
    if (value !== '16:9' && value !== '9:16') return;
    if (props.videoAspect === undefined) setLocalAspect(value);
    props.onVideoAspect?.(value);
  }

  function send() {
    if (props.busy || !props.ready || props.uploading || !prompt.trim()) return;
    if (mediaUnavailable) { props.onError(capabilityNotice); return; }
    if (tool === 'image' && !imageAcknowledgedRef.current) { setImageNoticeOpen(true); return; }
    props.onSend();
  }

  function dictate() {
    if (listening) { recognition.current?.stop(); return; }
    const browser = window as SpeechWindow;
    const API = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (!API) { props.onError('이 브라우저에서는 음성 입력을 지원하지 않습니다. Chrome에서 사용하거나 직접 입력해주세요.'); return; }
    const speech = new API();
    speech.lang = navigator.language || 'ko-KR';
    speech.continuous = false;
    speech.interimResults = false;
    speech.onresult = event => {
      const transcript = Array.from(event.results).map(result => result[0]?.transcript || '').join(' ');
      props.onPrompt([latestPrompt.current, transcript].filter(Boolean).join(' ').slice(0, 32000));
      inputRef.current?.focus();
    };
    speech.onerror = event => {
      if (event.error !== 'aborted') props.onError(event.error === 'not-allowed' ? '음성 입력을 사용하려면 브라우저의 마이크 권한을 허용해주세요.' : '음성을 인식하지 못했습니다. 다시 시도해주세요.');
      setListening(false);
    };
    speech.onend = () => setListening(false);
    recognition.current = speech;
    try { speech.start(); setListening(true); }
    catch { props.onError('마이크를 시작할 수 없습니다. 브라우저 권한을 확인해주세요.'); }
  }

  const filtered = props.models.filter(model => `${model.name} ${model.provider}`.toLowerCase().includes(query.toLowerCase()));
  const fileItems = <SavedFileItems files={props.files} attached={props.attached} onAttach={props.onAttach} onDetach={props.onDetach} onSelect={() => { focusAfterMenu.current = 'composer'; }} />;
  const additionalTools = <>
    <DropdownMenu.Item className="prism-tool-item" onSelect={props.onMusic} disabled={!props.onMusic || props.busy} title={capabilities.music ? '음악 생성 작업 공간을 엽니다.' : '음악 생성 연결 상태를 확인합니다.'}><Music2 size={17} aria-hidden="true" /><span>음악 만들기</span>{!capabilities.music && <span className="prism-tool-availability">연결 필요</span>}</DropdownMenu.Item>
    <DropdownMenu.Item className="prism-tool-item" onSelect={() => chooseTool('canvas')}><PanelsTopLeft size={17} aria-hidden="true" /><span>Canvas</span></DropdownMenu.Item>
    <DropdownMenu.Item className="prism-tool-item" onSelect={() => chooseTool('research')}><Atom size={17} aria-hidden="true" /><span>Deep Research</span></DropdownMenu.Item>
    <DropdownMenu.Item className="prism-tool-item" onSelect={() => chooseTool('learning')}><BookOpen size={17} aria-hidden="true" /><span>가이드 학습</span></DropdownMenu.Item>
  </>;

  return <div className="gemini-compose-wrap" data-composer-tool={tool}>
    {isMedia && props.mediaReference && <div className="gemini-media-reference" aria-label="참조 이미지">
      {props.mediaReference.url ? <img src={props.mediaReference.url} alt="첨부한 참조 이미지" /> : <ImagePlus size={24} aria-hidden="true" />}
      <span><strong>참조 이미지</strong><span>{props.mediaReference.name}</span></span>
      {props.onRemoveMediaReference && <button type="button" aria-label="참조 이미지 제거" disabled={props.busy || props.uploading} onClick={props.onRemoveMediaReference}><X size={18} aria-hidden="true" /></button>}
    </div>}
    {!isMedia && props.selectedSkill && <div className="gemini-attachments"><span><ScrollText size={14} aria-hidden="true" /><span>{props.selectedSkill.name}</span><button type="button" disabled={props.busy} aria-label="스킬 적용 해제" onClick={() => props.onSkill(null)}><X size={14} aria-hidden="true" /></button></span></div>}
    {!isMedia && props.attached.length > 0 && <div className="gemini-attachments" aria-label="첨부 파일">
      {props.attached.map(id => <span key={id}><FileText size={14} aria-hidden="true" /><span>{props.files.find(file => file.id === id)?.name || '첨부 문서'}</span><button type="button" disabled={props.busy} aria-label={`${props.files.find(file => file.id === id)?.name || '첨부 문서'} 첨부 제거`} onClick={() => props.onDetach(id)}><X size={14} aria-hidden="true" /></button></span>)}
    </div>}
    <div className="gemini-composer" data-tool={tool} data-expanded={expanded} data-multiline={prompt.includes('\n') || prompt.length > 100}>
      <DropdownMenu.Root open={toolsOpen} onOpenChange={open => { setToolsOpen(open); if (!open) setMoreToolsOpen(false); }}>
        <DropdownMenu.Trigger asChild><button type="button" className="gemini-add" aria-label="파일 및 도구 추가" disabled={props.busy || props.uploading}>{props.uploading ? <LoaderCircle size={24} className="spin" aria-hidden="true" /> : toolsOpen ? <X size={23} aria-hidden="true" /> : <Plus size={26} aria-hidden="true" />}</button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content
          className="prism-tool-menu prism-composer-menu"
          side="bottom" align="start" sideOffset={8} collisionPadding={12} loop
          onCloseAutoFocus={event => {
            if (focusAfterMenu.current !== 'trigger') {
              event.preventDefault();
              if (focusAfterMenu.current === 'composer') inputRef.current?.focus();
              focusAfterMenu.current = 'trigger';
            }
          }}
        >
          <DropdownMenu.Item className="prism-tool-item" onSelect={isMedia ? props.onMediaUpload : props.onUpload} disabled={isMedia && !props.onMediaUpload}><Paperclip size={18} aria-hidden="true" /><span>파일 업로드</span></DropdownMenu.Item>
          {!isMedia && <DropdownMenu.Item className="prism-tool-item" onSelect={props.onDriveUpload} disabled={!props.onDriveUpload || props.busy || props.uploading} title={capabilities.drive ? 'Google Drive에서 문서를 선택합니다.' : 'Google Drive 연결 설정을 엽니다.'}><Cloud size={18} aria-hidden="true" /><span>Drive에서 파일 추가</span>{!capabilities.drive && <span className="prism-tool-availability">연결</span>}</DropdownMenu.Item>}
          {isMobile ? <DropdownMenu.Item className="prism-tool-item" onSelect={() => props.onNavigate('/files')}><FolderOpen size={18} aria-hidden="true" /><span>내 파일 열기</span></DropdownMenu.Item> : <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="prism-tool-item"><MoreHorizontal size={18} aria-hidden="true" /><span>업로드 더보기</span><ChevronRight className="prism-tool-chevron" size={16} aria-hidden="true" /></DropdownMenu.SubTrigger>
            <DropdownMenu.Portal><DropdownMenu.SubContent className="prism-tool-menu prism-composer-upload-menu" sideOffset={4} collisionPadding={12} loop>
              <DropdownMenu.Item className="prism-tool-item" onSelect={() => props.onNavigate('/files')}><FolderOpen size={18} aria-hidden="true" /><span>내 파일 열기</span></DropdownMenu.Item>
              {!isMedia && <><DropdownMenu.Separator className="prism-menu-divider" />{fileItems}</>}
            </DropdownMenu.SubContent></DropdownMenu.Portal>
          </DropdownMenu.Sub>}
          {!props.compare && <>
            <DropdownMenu.Separator className="prism-menu-divider" />
            <DropdownMenu.Item className="prism-tool-item" onSelect={() => chooseTool('image')}><Image size={18} aria-hidden="true" /><span>이미지 만들기</span></DropdownMenu.Item>
            <DropdownMenu.Item className="prism-tool-item" onSelect={() => chooseTool('video')}><Video size={18} aria-hidden="true" /><span>동영상 만들기</span></DropdownMenu.Item>
            {isMobile ? <><DropdownMenu.Separator className="prism-menu-divider" />{additionalTools}</> : <DropdownMenu.Sub open={moreToolsOpen} onOpenChange={setMoreToolsOpen}>
              <DropdownMenu.SubTrigger className="prism-tool-item"><MoreHorizontal size={18} aria-hidden="true" /><span>도구 더보기</span><ChevronRight className="prism-tool-chevron" size={16} aria-hidden="true" /></DropdownMenu.SubTrigger>
              <DropdownMenu.Portal><DropdownMenu.SubContent className="prism-tool-menu prism-composer-more-menu" sideOffset={0} alignOffset={-124} collisionPadding={8} loop>
                {additionalTools}
              </DropdownMenu.SubContent></DropdownMenu.Portal>
            </DropdownMenu.Sub>}
          </>}
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
      <textarea
        ref={inputRef} className="gemini-prompt" aria-label="메시지 입력"
        aria-describedby={showCapabilityNotice ? capabilityNoticeId : undefined}
        value={prompt} rows={1} maxLength={32000} disabled={props.busy} placeholder={placeholder} enterKeyHint="send"
        onChange={event => props.onPrompt(event.target.value)}
        onKeyDown={event => {
          if (mentionOpen && event.key === 'ArrowDown') { event.preventDefault(); mentionRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); return; }
          if (event.key === 'Escape' && mentionOpen) { event.preventDefault(); props.onPrompt(prompt.replace(/(^|\s)@[^\s@]*$/, '$1')); return; }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            if (mentionOpen) mentionRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
            else send();
          }
        }}
      />
      {details && ToolIcon && <button type="button" className="gemini-tool-chip" disabled={props.busy} aria-label={`${details.label} 모드 해제`} title={`${details.label} 모드 해제`} onClick={() => applyTool('chat')}>
        <span className="gemini-tool-chip-symbol"><ToolIcon className="gemini-tool-chip-icon" size={19} aria-hidden="true" /><X className="gemini-tool-chip-remove" size={18} aria-hidden="true" /></span>
        <span>{details.label}</span>
      </button>}
      <div className="gemini-composer-actions">
        {!props.compare && props.mode !== 'work' && !isMedia && tool !== 'learning' && <Popover.Root open={modelOpen} onOpenChange={open => { setModelOpen(open); if (!open) setQuery(''); }}>
          <Popover.Trigger asChild><button type="button" className="gemini-model-trigger" disabled={props.busy} aria-label={`모델 선택: ${props.selected.name}`}><span>{isFreeModel(props.selected.id) ? 'Flash-Lite' : props.selected.name}</span><ChevronDown size={18} aria-hidden="true" /></button></Popover.Trigger>
          <Popover.Portal><Popover.Content className="prism-model-menu" side="bottom" align="end" sideOffset={14} collisionPadding={12}>
            <div className="prism-model-menu-heading"><strong>모델 선택</strong><Popover.Close className="prism-icon" aria-label="모델 선택 닫기"><X size={18} aria-hidden="true" /></Popover.Close></div>
            <label className="prism-model-search"><Search size={17} aria-hidden="true" /><input placeholder="모델 검색" aria-label="모델 검색" value={query} onChange={event => setQuery(event.target.value)} /></label>
            <div className="prism-model-options" role="group" aria-label="AI 모델">
              {filtered.map(model => {
                const free = isFreeModel(model.id), locked = !free && (!props.signedIn || (props.walletBalance ?? 0) <= 0);
                return <button type="button" key={model.id} aria-pressed={model.id === props.selected.id} className="prism-model-option" data-locked={locked || undefined} onClick={() => { props.onModel(model); setModelOpen(false); setQuery(''); }}><span className={`prism-provider-dot ${model.provider}`} /><span><strong>{model.name}</strong><small>{free ? '무료 · 일일 한도 적용' : !props.signedIn ? '유료 · 로그인 후 크레딧 충전 필요' : props.walletBalance === null ? '유료 · 잔액 확인 중' : locked ? '유료 · 크레딧 충전 후 이용 가능' : '유료 · 사용량만큼 크레딧 차감'}{!props.providers[model.provider].configured ? ' · 연결 준비 중' : ''}</small></span>{locked ? <LockKeyhole size={16} aria-hidden="true" /> : model.id === props.selected.id && <Check size={18} aria-hidden="true" />}</button>;
              })}
              {filtered.length === 0 && <p className="prism-menu-empty">일치하는 모델이 없습니다.</p>}
            </div>
            {props.selected.efforts.length > 0 && <label className="prism-reasoning"><SlidersHorizontal size={17} aria-hidden="true" /><span>추론 수준</span><select aria-label="추론 수준" value={props.effort} onChange={event => props.onEffort(event.target.value)}>{props.selected.efforts.map(effort => <option key={effort} value={effort}>{{none:'Off',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra High',max:'Max'}[effort]||effort}</option>)}</select></label>}
            {props.selected.pro && props.onPro && <label className="prism-reasoning"><SlidersHorizontal size={17} aria-hidden="true" /><span>추론 모드</span><select aria-label="추론 모드" value={props.pro?'pro':'standard'} onChange={event=>props.onPro?.(event.target.value==='pro')}><option value="standard">Standard</option><option value="pro">Pro</option></select></label>}
            <button type="button" className="prism-model-library" onClick={() => { setModelOpen(false); props.onNavigate('/models'); }}>전체 모델 라이브러리</button>
          </Popover.Content></Popover.Portal>
        </Popover.Root>}
        {isMedia && <Popover.Root>
          <Popover.Trigger asChild><button type="button" className="gemini-model-trigger gemini-media-model" disabled={props.busy} aria-label={`${tool === 'image' ? '이미지' : '동영상'} 모델 연결 상태`}><span>{mediaUnavailable ? '설정 필요' : props.mediaModelLabel || `${tool === 'image' ? '이미지' : '동영상'} 모델`}</span><ChevronDown size={16} aria-hidden="true" /></button></Popover.Trigger>
          <Popover.Portal><Popover.Content className="prism-tool-menu prism-source-popover" side="bottom" align="end" sideOffset={10} collisionPadding={12}>
            <div className="prism-source-heading"><strong>{tool === 'image' ? '이미지' : '동영상'} 생성</strong><Popover.Close className="prism-icon" aria-label="모델 연결 상태 닫기"><X size={18} aria-hidden="true" /></Popover.Close></div>
            <p className="prism-source-note">{mediaUnavailable ? capabilityNotice : `현재 생성 모델: ${props.mediaModelLabel || (tool === 'image' ? '연결된 이미지 모델' : '연결된 동영상 모델')}`}</p>
            <button type="button" className="prism-model-library" onClick={() => props.onNavigate('/settings')}>연결 설정 보기</button>
          </Popover.Content></Popover.Portal>
        </Popover.Root>}
        {props.compare && <label className="prism-compare-effort"><SlidersHorizontal size={16} aria-hidden="true" /><select aria-label="비교 추론 수준" disabled={props.busy} value={props.effort} onChange={event => props.onEffort(event.target.value)}>{['low', 'medium', 'high'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
        <button type="button" className={'gemini-mic' + (listening ? ' is-listening' : '')} aria-label={listening ? '음성 입력 중지' : '음성 입력'} title="브라우저 음성 인식 · 마이크 사용 시에만 시작" aria-pressed={listening} disabled={props.busy} onClick={dictate}><Mic size={22} aria-hidden="true" /></button>
        {props.busy ? <button type="button" className="gemini-send" aria-label="응답 중지" onClick={props.onStop}><Square size={16} fill="currentColor" aria-hidden="true" /></button> : prompt.trim() ? <button type="button" className="gemini-send" aria-label="메시지 보내기" title={mediaUnavailable ? capabilityNotice : undefined} disabled={!props.ready || props.uploading || mediaUnavailable} onClick={send}><ArrowUp size={21} aria-hidden="true" /></button> : null}
      </div>
      {tool === 'research' && <div className="gemini-tool-options">
        <Popover.Root open={sourcesOpen} onOpenChange={setSourcesOpen}>
          <Popover.Trigger asChild><button type="button" className="gemini-option-button" disabled={props.busy} aria-label="조사 소스 설정"><Globe2 size={16} aria-hidden="true" /><span>소스</span>{sources.web && capabilities.webResearch && <span className="gemini-source-active" aria-label="웹 검색 사용" />}</button></Popover.Trigger>
          <Popover.Portal><Popover.Content className="prism-tool-menu prism-source-popover" side="bottom" align="start" sideOffset={10} collisionPadding={12}>
            <div className="prism-source-heading"><strong>조사 소스</strong><Popover.Close className="prism-icon" aria-label="소스 설정 닫기"><X size={18} aria-hidden="true" /></Popover.Close></div>
            <label className="prism-source-row"><Globe2 size={19} aria-hidden="true" /><span><strong>웹 검색</strong><small id={webSourceNoticeId}>{capabilities.webResearch ? '웹에서 출처를 검색합니다.' : '현재 연결되지 않았습니다.'}</small></span><input type="checkbox" aria-label="웹 검색 사용" aria-describedby={webSourceNoticeId} checked={capabilities.webResearch && sources.web} disabled={!capabilities.webResearch || props.busy} onChange={event => updateSources(event.target.checked)} /></label>
            {props.onDriveUpload && <button type="button" className="prism-source-row prism-source-drive" disabled={props.busy || props.uploading} onClick={() => { setSourcesOpen(false); props.onDriveUpload?.(); }}><Cloud size={19} aria-hidden="true" /><span><strong>Google Drive</strong><small>{capabilities.drive ? 'Drive 문서를 조사에 추가합니다.' : '계정을 연결하고 조사할 문서를 선택하세요.'}</small></span><ChevronRight size={18} aria-hidden="true" /></button>}
            <div className="prism-source-row"><FileText size={19} aria-hidden="true" /><span><strong>첨부 파일</strong><small>{props.attached.length ? `${props.attached.length}개의 파일을 조사에 사용합니다.` : '파일 버튼으로 조사할 문서를 첨부하세요.'}</small></span>{props.attached.length > 0 && <Check size={18} aria-hidden="true" />}</div>
            <p className="prism-source-note">{capabilities.webResearch ? '선택한 소스와 첨부 파일을 바탕으로 조사합니다.' : '현재는 첨부 문서 분석을 지원합니다. 웹 검색과 백그라운드 조사는 제공하지 않습니다.'}</p>
          </Popover.Content></Popover.Portal>
        </Popover.Root>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><button type="button" className="gemini-option-button" disabled={props.busy || props.uploading} aria-label="조사 파일 첨부"><Upload size={16} aria-hidden="true" /><span>파일{props.attached.length ? ` · ${props.attached.length}` : ''}</span></button></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className="prism-tool-menu prism-composer-upload-menu" side="bottom" align="end" sideOffset={10} collisionPadding={12} loop onCloseAutoFocus={event => { if (focusAfterMenu.current === 'composer') { event.preventDefault(); focusAfterMenu.current = 'trigger'; inputRef.current?.focus(); } }}>
            <DropdownMenu.Item className="prism-tool-item" onSelect={props.onUpload}><Upload size={18} aria-hidden="true" /><span>파일 업로드</span></DropdownMenu.Item>
            <DropdownMenu.Separator className="prism-menu-divider" />{fileItems}
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>}
      {tool === 'video' && <div className="gemini-tool-options">
        <button type="button" className="gemini-option-button" aria-label="참조 이미지 추가" disabled={props.busy || props.uploading || !capabilities.video || !props.onMediaUpload} title={!capabilities.video || !props.onMediaUpload ? '동영상 서비스 연결과 승인된 동영상 이용 한도가 필요합니다.' : '참조 이미지 추가'} onClick={props.onMediaUpload}><ImagePlus size={18} aria-hidden="true" /></button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><button type="button" className="gemini-option-button" aria-label={`동영상 비율: ${videoAspect === '16:9' ? '가로' : '세로'}`} disabled={props.busy}>{videoAspect === '16:9' ? <RectangleHorizontal size={16} aria-hidden="true" /> : <RectangleVertical size={16} aria-hidden="true" />}<span>{videoAspect === '16:9' ? '가로' : '세로'}</span><ChevronDown size={15} aria-hidden="true" /></button></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className="prism-tool-menu prism-aspect-menu" side="bottom" align="end" sideOffset={10} collisionPadding={12} loop><DropdownMenu.RadioGroup value={videoAspect} onValueChange={updateAspect} aria-label="동영상 비율">
            <DropdownMenu.RadioItem className="prism-tool-item" value="16:9"><RectangleHorizontal size={18} aria-hidden="true" /><span>가로 · 16:9</span><DropdownMenu.ItemIndicator className="prism-tool-check"><Check size={16} aria-hidden="true" /></DropdownMenu.ItemIndicator></DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem className="prism-tool-item" value="9:16"><RectangleVertical size={18} aria-hidden="true" /><span>세로 · 9:16</span><DropdownMenu.ItemIndicator className="prism-tool-check"><Check size={16} aria-hidden="true" /></DropdownMenu.ItemIndicator></DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup></DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>}
    </div>
    {showCapabilityNotice && <p id={capabilityNoticeId} className="gemini-capability-note" role="status">{capabilityNotice} <button type="button" onClick={() => props.onNavigate('/settings')}>연결 상태 보기</button></p>}
    <span className="prism-composer-live" role="status" aria-live="polite">{details ? `${details.label} 모드 선택됨` : '일반 채팅 모드'}</span>
    {mentionOpen && <div ref={mentionRef} className="prism-mention-menu prism-tool-menu" role="dialog" aria-label="스킬 및 연결" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); props.onPrompt(prompt.replace(/(^|\s)@[^\s@]*$/, '$1')); inputRef.current?.focus(); } }}>
      {loadingSkills && <p className="prism-tool-note" role="status">스킬을 불러오는 중…</p>}
      {skillError && <p className="prism-tool-note" role="alert">{skillError}</p>}
      {skills.filter(skill => skill.name.toLowerCase().includes((mention?.[1] || '').toLowerCase())).map(skill => <button type="button" key={skill.id} className="prism-tool-item" onClick={() => { props.onSkill(skill); props.onPrompt(prompt.replace(/(^|\s)@[^\s@]*$/, '$1')); inputRef.current?.focus(); }}><ScrollText size={18} aria-hidden="true" /><span>{skill.name}</span></button>)}
      <button type="button" className="prism-tool-item" onClick={() => props.onNavigate('/customize/skills')}><ScrollText size={18} aria-hidden="true" />스킬 관리</button>
      <button type="button" className="prism-tool-item" onClick={() => props.onNavigate('/settings')}><PlugZap size={18} aria-hidden="true" />AI 연결 설정</button>
    </div>}
    {listening && <p className="prism-listening" role="status">듣고 있습니다… 음성 인식은 브라우저의 음성 서비스를 사용할 수 있습니다.</p>}
    <Dialog.Root open={imageNoticeOpen} onOpenChange={setImageNoticeOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="prism-image-notice-overlay" />
        <Dialog.Content
          className="prism-image-notice"
          onOpenAutoFocus={event => { event.preventDefault(); imageCancelRef.current?.focus(); }}
          onCloseAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); }}
        >
          <Dialog.Title>이미지 및 파일에서 콘텐츠 생성</Dialog.Title>
          <Dialog.Description>업로드하는 이미지와 파일을 사용할 권리가 있는지 확인해 주세요. 타인을 속이거나 괴롭히거나 타인의 권리를 침해하는 콘텐츠를 만들지 마세요. 생성 요청은 연결된 AI 서비스에서 처리되며 해당 서비스의 이용 정책이 적용됩니다.</Dialog.Description>
          <div className="prism-image-notice-actions">
            <Dialog.Close ref={imageCancelRef} className="prism-image-notice-cancel">취소</Dialog.Close>
            <button type="button" className="prism-image-notice-confirm" onClick={() => {
              imageAcknowledgedRef.current = true;
              try { localStorage.setItem(imageNoticeKey, 'acknowledged'); } catch { /* Keep the acknowledgement in memory when storage is unavailable. */ }
              setImageNoticeOpen(false);
              if (tool !== 'image') applyTool('image');
              else inputRef.current?.focus();
            }}>확인</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
