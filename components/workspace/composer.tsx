'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { DropdownMenu, Popover } from 'radix-ui';
import { ArrowUp, Check, ChevronDown, FileText, FolderOpen, Image, LoaderCircle, Mic, Plus, Search, SlidersHorizontal, Square, Upload, Video, X, ScrollText, PlugZap } from 'lucide-react';
import type { Model, Provider } from '../../lib/models';

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

export type ComposerProps = {
  prompt: string; onPrompt(value: string): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  models: Model[]; selected: Model; onModel(model: Model): void;
  providers: Record<Provider, { configured: boolean }>;
  effort: string; onEffort(value: string): void;
  mode: 'chat' | 'work'; compare?: boolean;
  busy: boolean; ready: boolean; uploading: boolean;
  files: FileItem[]; attached: string[];
  onAttach(id: string): void; onDetach(id: string): void; onUpload(): void;
  onSend(): void; onStop(): void; onNavigate(path: string): void;
  onError(message: string): void;
  signedIn: boolean;
  selectedSkill: {id: string; name: string} | null;
  onSkill(skill: {id: string; name: string} | null): void;
};

export function Composer(props: ComposerProps) {
  const [modelOpen, setModelOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const latestPrompt = useRef(props.prompt);
  latestPrompt.current = props.prompt;
  const mentionRef = useRef<HTMLDivElement>(null);
  const [skills, setSkills] = useState<Array<{id:string;name:string}>>([]);
  const [skillError, setSkillError] = useState('');
  const [loadingSkills, setLoadingSkills] = useState(false);
  const mention = /(?:^|\s)@([^\s@]*)$/.exec(props.prompt);
  const mentionOpen = !!mention;
  const { inputRef, prompt } = props;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = '24px';
    input.style.height = `${Math.min(144, input.scrollHeight)}px`;
  }, [prompt, inputRef]);
  useEffect(() => () => recognition.current?.abort(), []);
  useEffect(() => { if (props.busy) recognition.current?.abort(); }, [props.busy]);
  useEffect(() => {
    if (!mentionOpen || !props.signedIn) return;
    const controller = new AbortController(); setLoadingSkills(true); setSkillError('');
    fetch('/api/settings', {signal:controller.signal}).then(async response => {
      const data = await response.json() as {error?:string;skills?:Array<{id:string;name:string}>};
      if (!response.ok) throw new Error(data.error || '스킬을 불러오지 못했습니다.');
      if (!controller.signal.aborted) setSkills(Array.isArray(data.skills) ? data.skills : []);
    }).catch(error => { if (!controller.signal.aborted) setSkillError(error instanceof Error ? error.message : '스킬을 불러오지 못했습니다.'); }).finally(() => { if (!controller.signal.aborted) setLoadingSkills(false); });
    return () => controller.abort();
  }, [mentionOpen, props.signedIn]);

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
  return <div className="gemini-compose-wrap">
    {props.selectedSkill && <div className="gemini-attachments"><span><ScrollText size={14}/><span>{props.selectedSkill.name}</span><button type="button" disabled={props.busy} aria-label="스킬 적용 해제" onClick={() => props.onSkill(null)}><X size={14}/></button></span></div>}
    {props.attached.length > 0 && <div className="gemini-attachments" aria-label="첨부 파일">
      {props.attached.map(id => <span key={id}><FileText size={14}/><span>{props.files.find(file => file.id === id)?.name || '첨부 문서'}</span><button type="button" disabled={props.busy} aria-label="첨부 제거" onClick={() => props.onDetach(id)}><X size={14}/></button></span>)}
    </div>}
    <div className="gemini-composer" data-multiline={prompt.includes('\n') || prompt.length > 100}>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild><button type="button" className="gemini-add" aria-label="파일 및 도구 추가" disabled={props.busy || props.uploading}>{props.uploading ? <LoaderCircle size={24} className="spin"/> : <Plus size={26}/>}</button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="prism-tool-menu" side="bottom" align="start" sideOffset={12} collisionPadding={12}>
          <DropdownMenu.Item className="prism-tool-item" onSelect={props.onUpload}><Upload size={18}/>파일 업로드</DropdownMenu.Item>
          <DropdownMenu.Item className="prism-tool-item" onSelect={() => props.onNavigate('/files')}><FolderOpen size={18}/>내 파일 열기</DropdownMenu.Item>
          {props.files.length > 0 && <DropdownMenu.Sub><DropdownMenu.SubTrigger className="prism-tool-item"><FileText size={18}/>저장된 문서 첨부<ChevronDown size={14}/></DropdownMenu.SubTrigger><DropdownMenu.Portal><DropdownMenu.SubContent className="prism-tool-menu" sideOffset={4} collisionPadding={12}>{props.files.map(file => <DropdownMenu.CheckboxItem key={file.id} className="prism-tool-item" checked={props.attached.includes(file.id)} onCheckedChange={checked => checked ? props.onAttach(file.id) : props.onDetach(file.id)}><FileText size={16}/><span>{file.name}</span><DropdownMenu.ItemIndicator><Check size={15}/></DropdownMenu.ItemIndicator></DropdownMenu.CheckboxItem>)}</DropdownMenu.SubContent></DropdownMenu.Portal></DropdownMenu.Sub>}
          <DropdownMenu.Separator className="prism-menu-divider"/>
          <DropdownMenu.Item className="prism-tool-item" onSelect={() => props.onNavigate('/images')}><Image size={18}/>이미지 생성<span className="prism-unavailable-label">미연결</span></DropdownMenu.Item>
          <DropdownMenu.Item className="prism-tool-item" onSelect={() => props.onNavigate('/videos')}><Video size={18}/>동영상 생성<span className="prism-unavailable-label">미연결</span></DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
      <textarea ref={inputRef} className="gemini-prompt" aria-label="메시지 입력" value={prompt} rows={1} maxLength={32000} disabled={props.busy}
        placeholder={props.compare ? '여러 모델에 같은 질문을 입력하세요' : props.mode === 'work' ? '어떤 작업을 도와드릴까요?' : '커넥터, 스킬 등을 보려면 @ 입력하세요'}
        onChange={event => props.onPrompt(event.target.value)}
        onKeyDown={event => { if (mentionOpen && event.key === 'ArrowDown') { event.preventDefault(); mentionRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); return; } if (event.key === 'Escape' && mentionOpen) { event.preventDefault(); props.onPrompt(prompt.replace(/(^|\s)@[^\s@]*$/, '$1')); return; } if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (mentionOpen) mentionRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); else props.onSend(); } }}/>
      <div className="gemini-composer-actions">
        {!props.compare && <Popover.Root open={modelOpen} onOpenChange={open => { setModelOpen(open); if (!open) setQuery(''); }}>
          <Popover.Trigger asChild><button type="button" className="gemini-model-trigger" disabled={props.busy} aria-label={`모델 선택: ${props.selected.name}`}><span>{props.selected.name}</span><ChevronDown size={18}/></button></Popover.Trigger>
          <Popover.Portal><Popover.Content className="prism-model-menu" side="bottom" align="end" sideOffset={14} collisionPadding={12}>
            <div className="prism-model-menu-heading"><strong>모델 선택</strong><Popover.Close className="prism-icon" aria-label="모델 선택 닫기"><X size={18}/></Popover.Close></div>
            <label className="prism-model-search"><Search size={17}/><input placeholder="모델 검색" aria-label="모델 검색" value={query} onChange={event => setQuery(event.target.value)}/></label>
            <div className="prism-model-options" role="group" aria-label="AI 모델">
              {filtered.map(model => <button type="button" key={model.id} aria-pressed={model.id === props.selected.id} className="prism-model-option" onClick={() => { props.onModel(model); setModelOpen(false); setQuery(''); }}><span className={`prism-provider-dot ${model.provider}`}/><span><strong>{model.name}</strong><small>{model.category} · {props.providers[model.provider].configured ? '연결됨' : 'API 연결 필요'}</small></span>{model.id === props.selected.id && <Check size={18}/>}</button>)}
              {filtered.length === 0 && <p className="prism-menu-empty">일치하는 모델이 없습니다.</p>}
            </div>
            {props.selected.efforts.length > 0 && <label className="prism-reasoning"><SlidersHorizontal size={17}/><span>추론 수준</span><select aria-label="추론 수준" value={props.effort} onChange={event => props.onEffort(event.target.value)}>{props.selected.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>}
            <button type="button" className="prism-model-library" onClick={() => { setModelOpen(false); props.onNavigate('/models'); }}>전체 모델 라이브러리</button>
          </Popover.Content></Popover.Portal>
        </Popover.Root>}
        {props.compare && <label className="prism-compare-effort"><SlidersHorizontal size={16}/><select aria-label="비교 추론 수준" disabled={props.busy} value={props.effort} onChange={event => props.onEffort(event.target.value)}>{['low','medium','high'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
        <button type="button" className={'gemini-mic' + (listening ? ' is-listening' : '')} aria-label={listening ? '음성 입력 중지' : '음성 입력'} title="브라우저 음성 인식 · 마이크 사용 시에만 시작" aria-pressed={listening} disabled={props.busy} onClick={dictate}><Mic size={22}/></button>
        {props.busy ? <button type="button" className="gemini-send" aria-label="응답 중지" onClick={props.onStop}><Square size={16} fill="currentColor"/></button> : prompt.trim() ? <button type="button" className="gemini-send" aria-label="메시지 보내기" disabled={!props.ready || props.uploading} onClick={props.onSend}><ArrowUp size={21}/></button> : null}
      </div>
    </div>
    {mentionOpen && <div ref={mentionRef} className="prism-mention-menu prism-tool-menu" role="dialog" aria-label="스킬 및 연결" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); props.onPrompt(prompt.replace(/(^|\s)@[^\s@]*$/, '$1')); inputRef.current?.focus(); } }}>
      {loadingSkills && <p className="prism-tool-note" role="status">스킬을 불러오는 중…</p>}
      {skillError && <p className="prism-tool-note" role="alert">{skillError}</p>}
      {skills.filter(skill => skill.name.toLowerCase().includes((mention?.[1] || '').toLowerCase())).map(skill => <button type="button" key={skill.id} className="prism-tool-item" onClick={() => { props.onSkill(skill); props.onPrompt(prompt.replace(/(^|\s)@[^\s@]*$/, '$1')); inputRef.current?.focus(); }}><ScrollText size={18}/><span>{skill.name}</span></button>)}
      <button type="button" className="prism-tool-item" onClick={() => props.onNavigate('/customize/skills')}><ScrollText size={18}/>스킬 관리</button>
      <button type="button" className="prism-tool-item" onClick={() => props.onNavigate('/settings')}><PlugZap size={18}/>AI 연결 설정</button>
    </div>}
    {listening && <p className="prism-listening" role="status">듣고 있습니다… 음성 인식은 브라우저의 음성 서비스를 사용할 수 있습니다.</p>}
  </div>;
}
