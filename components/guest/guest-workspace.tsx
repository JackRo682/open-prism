'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUp, Check, ChevronDown, ChevronRight, Copy, Download, FilePlus2, HelpCircle, ImagePlus, LoaderCircle, LockKeyhole, Menu, Mic, Moon, MoreHorizontal, Pencil, Plus, RefreshCw, Settings, Sparkles, Square, SquarePen, Sun, X } from 'lucide-react';
import { useWorkspaceTheme, type ThemePreference } from '../workspace/theme';
import { readGuestSession, writeGuestSession, type GuestMessage, type GuestSession } from '../../lib/guest-session';
import GuestMarkdown from './guest-markdown';
import GuestDialog from './guest-dialog';

type Bootstrap = {
  available: boolean;
  model: { id: string; name: string; provider: string };
  remaining: number;
  limit: number;
  resetsAt: string | null;
  maxPromptBytes: number;
  maxInputBytes: number;
  maxHistoryTurns: number;
  code?: string;
  error?: string;
};
type Popup = 'tools' | 'model' | 'settings' | 'theme' | `response-${string}` | null;
type Modal = 'new-chat' | 'install' | null;
type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
type SpeechResultEvent = { results: { [index: number]: { [index: number]: { transcript: string }; isFinal: boolean }; length: number }; resultIndex: number };
type SpeechRecognizer = { lang: string; continuous: boolean; interimResults: boolean; onresult: ((event: SpeechResultEvent) => void) | null; onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null; start(): void; stop(): void; abort(): void };

const DEFAULT_MODEL = 'GPT-6.1 Sol';
const bytes = (value: string) => new TextEncoder().encode(value).length;
function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const random = crypto.getRandomValues(new Uint8Array(16));
  random[6] = (random[6] & 0x0f) | 0x40;
  random[8] = (random[8] & 0x3f) | 0x80;
  const hex = [...random].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function PrismMark({ size = 24 }: { size?: number }) {
  const id = useId();
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id={id} x1="3" y1="2" x2="21" y2="22" gradientUnits="userSpaceOnUse"><stop stopColor="#75adff"/><stop offset=".34" stopColor="#a789f5"/><stop offset=".61" stopColor="#f3b8d0"/><stop offset=".84" stopColor="#e0cf8a"/><stop offset="1" stopColor="#70c7a1"/></linearGradient></defs><path d="M12 1.5C13.5 7.8 16.2 10.5 22.5 12C16.2 13.5 13.5 16.2 12 22.5C10.5 16.2 7.8 13.5 1.5 12C7.8 10.5 10.5 7.8 12 1.5Z" fill={`url(#${id})`}/></svg>;
}

function boundedHistory(messages: GuestMessage[], prompt: string, bootstrap: Bootstrap) {
  const pairs: { role: 'user' | 'assistant'; content: string }[][] = [];
  for (let index = 0; index + 1 < messages.length; index += 2) {
    const question = messages[index], answer = messages[index + 1];
    if (question.role === 'user' && answer.role === 'assistant' && answer.status === 'complete' && answer.content.trim()) pairs.push([{ role: 'user', content: question.content }, { role: 'assistant', content: answer.content }]);
  }
  const history = pairs.slice(-Math.floor(bootstrap.maxHistoryTurns / 2)).flat();
  while (history.length && bytes(prompt) + history.reduce((sum, item) => sum + bytes(item.content), 0) > bootstrap.maxInputBytes) history.splice(0, 2);
  return history;
}

export default function GuestWorkspace({ signInHref = '/signin-with-chatgpt?return_to=%2Fchat' }: { signInHref?: string }) {
  const { theme, setTheme } = useWorkspaceTheme();
  const [messages, setMessages] = useState<GuestMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [ready, setReady] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [popup, setPopup] = useState<Popup>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [composerError, setComposerError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [installMessage, setInstallMessage] = useState('');
  const [listening, setListening] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const popupTrigger = useRef<HTMLElement | null>(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const speechRef = useRef<SpeechRecognizer | null>(null);
  const epochRef = useRef(0);
  const mountedRef = useRef(false);
  const streamingRef = useRef(false);
  const nearBottomRef = useRef(true);
  const messagesRef = useRef(messages);
  const surfaceRef = useRef({ popup, modal });
  surfaceRef.current = { popup, modal };
  messagesRef.current = messages;
  const empty = messages.length === 0;
  const modelName = bootstrap?.model.name || DEFAULT_MODEL;
  const unavailable = !bootstrap?.available || bootstrap.remaining <= 0;
  const canSubmit = ready && !bootLoading && !unavailable && !!draft.trim() && !streaming;

  const loadBootstrap = useCallback(async (signal?: AbortSignal) => {
    setBootLoading(true);
    setBootError('');
    try {
      const response = await fetch('/api/guest/bootstrap', { credentials: 'same-origin', cache: 'no-store', signal });
      const value = await response.json() as Bootstrap;
      if (!mountedRef.current || signal?.aborted) return;
      if (typeof value.available !== 'boolean' || !value.model || typeof value.remaining !== 'number') throw new Error('체험 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
      setBootstrap(value);
      if (!value.available) setBootError(value.error || '현재 체험 서비스를 이용할 수 없습니다.');
    } catch (error) {
      if (!mountedRef.current || signal?.aborted) return;
      setBootError(error instanceof Error && error.message.startsWith('체험') ? error.message : '연결을 확인한 후 다시 시도해 주세요.');
    } finally {
      if (mountedRef.current && !signal?.aborted) setBootLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const restored = readGuestSession();
    setSessionId(restored?.id || newId());
    if (restored) { setMessages(restored.messages); setDraft(restored.draft); setHasInteracted(restored.hasInteracted); }
    setReady(true);
    const controller = new AbortController();
    void loadBootstrap(controller.signal);
    const media = window.matchMedia('(max-width: 768px)');
    const onViewport = () => { setIsMobile(media.matches); setPopup(null); if (!media.matches) setDrawer(false); };
    onViewport();
    media.addEventListener('change', onViewport);
    const onInstall = (event: Event) => { event.preventDefault(); setInstallEvent(event as InstallEvent); };
    const onInstalled = () => { setInstallEvent(null); setInstallMessage('OpenPrism이 설치되었습니다.'); };
    window.addEventListener('beforeinstallprompt', onInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      mountedRef.current = false;
      epochRef.current++;
      controller.abort(); abortRef.current?.abort(); speechRef.current?.abort();
      media.removeEventListener('change', onViewport);
      window.removeEventListener('beforeinstallprompt', onInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [loadBootstrap]);

  useEffect(() => {
    if (!ready || !sessionId) return;
    writeGuestSession({ id: sessionId, messages, draft, savedAt: Date.now(), hasInteracted });
  }, [ready, sessionId, messages, draft, hasInteracted]);

  useEffect(() => {
    const input = inputRef.current;
    if (input) { input.style.height = '24px'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; }
  }, [draft]);

  useEffect(() => {
    if (nearBottomRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => setAnnouncement(''), 3500);
    return () => clearTimeout(timer);
  }, [announcement]);

  useEffect(() => {
    if (!popup) return;
    const visibleMenu = () => [...(rootRef.current?.querySelectorAll<HTMLElement>('.pg-popover') || [])].find(menu => menu.getClientRects().length > 0);
    const placeMenu = () => {
      const menu = visibleMenu();
      const trigger = popupTrigger.current;
      if (!menu || !trigger) return;
      const anchor = trigger.getBoundingClientRect();
      menu.style.maxHeight = '';
      const menuSize = menu.getBoundingClientRect();
      const below = window.innerHeight - anchor.bottom - 16;
      const above = anchor.top - 16;
      const headerMenu = trigger.closest('.pg-mobile-model-anchor');
      const preferBelow = headerMenu || (empty && trigger.closest('.pg-composer')) || trigger.closest('.pg-response-menu-anchor');
      const opensBelow = headerMenu || (preferBelow ? below >= menuSize.height || below > above : above < menuSize.height && below > above);
      const available = opensBelow ? below : above;
      menu.style.position = 'fixed';
      menu.style.maxHeight = `${Math.max(120, available)}px`;
      menu.style.overflowY = 'auto';
      const height = Math.min(menuSize.height, Math.max(120, available));
      const model = trigger.closest('.pg-desktop-model-anchor');
      const preferredLeft = model ? anchor.right - menuSize.width : anchor.left;
      menu.style.left = `${Math.max(12, Math.min(preferredLeft, window.innerWidth - menuSize.width - 12))}px`;
      menu.style.top = `${Math.max(12, opensBelow ? anchor.bottom + 10 : anchor.top - height - 10)}px`;
      menu.style.right = 'auto';
      menu.style.bottom = 'auto';
    };
    const timer = setTimeout(() => { placeMenu(); [...(visibleMenu()?.querySelectorAll<HTMLElement>('[role^="menuitem"]') || [])].find(item => !item.hasAttribute('disabled') && item.getClientRects().length)?.focus(); }, 0);
    const close = () => { setPopup(null); popupTrigger.current?.focus(); };
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.pg-popover, [data-popup-trigger]')) setPopup(null);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      const menu = visibleMenu();
      if (!menu?.contains(document.activeElement)) return;
      if (event.key === 'Tab') { setPopup(null); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter(item => item.getClientRects().length && !item.hasAttribute('disabled'));
      if (!items.length) return;
      event.preventDefault();
      const active = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', keyboard);
    window.addEventListener('resize', placeMenu);
    return () => { clearTimeout(timer); document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', keyboard); window.removeEventListener('resize', placeMenu); };
  }, [popup, empty]);

  useEffect(() => {
    if (!drawer) return;
    const previous = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => drawerRef.current?.querySelector<HTMLElement>('[data-drawer-close]')?.focus(), 0);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !surfaceRef.current.popup && !surfaceRef.current.modal) { event.preventDefault(); setDrawer(false); }
      if (event.key !== 'Tab' || surfaceRef.current.popup || surfaceRef.current.modal) return;
      const items = [...(drawerRef.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])') || [])].filter(item => item.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', key); previous?.isConnected && previous.focus(); };
  }, [drawer]);

  function togglePopup(next: Popup, trigger: HTMLElement) {
    popupTrigger.current = trigger;
    setPopup(current => current === next ? null : next);
  }

  function rememberSignIn() {
    speechRef.current?.abort(); speechRef.current = null; setListening(false);
    const interrupted = streamingRef.current;
    const currentMessages = messagesRef.current.map(message => message.status === 'streaming' ? { ...message, status: 'stopped' as const } : message);
    const latestQuestion = [...currentMessages].reverse().find(message => message.role === 'user');
    const resumedDraft = draft.trim() ? draft : interrupted ? latestQuestion?.content || '' : draft;
    if (interrupted) stop();
    const snapshot: GuestSession = { id: sessionId, messages: currentMessages, draft: resumedDraft, hasInteracted, savedAt: Date.now() };
    if (sessionId) writeGuestSession(snapshot);
    setDraft(resumedDraft);
    try {
      if (resumedDraft.trim()) sessionStorage.setItem('prism-signin-draft', JSON.stringify({ prompt: resumedDraft, tool: 'chat', savedAt: Date.now() }));
      else sessionStorage.removeItem('prism-signin-draft');
    } catch { /* Continue to real sign-in even when storage is disabled. */ }
  }

  const signIn = (className = '', label = '로그인', menuItem = false) => <a className={className} href={signInHref} target="_top" onClick={rememberSignIn} {...(menuItem ? { role: 'menuitem' } : {})}>{label}</a>;

  function stop() {
    const old = epochRef.current;
    epochRef.current = old + 1;
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    setStreaming(false);
    setMessages(current => current.map(message => message.status === 'streaming' ? { ...message, status: 'stopped' } : message));
    setAnnouncement('답변 생성을 중지했습니다.');
  }

  async function sendPrompt(value: string, retryUserIndex?: number) {
    const prompt = value.trim();
    if (!prompt || streamingRef.current || !bootstrap?.available || bootstrap.remaining <= 0) return;
    if (bytes(prompt) > bootstrap.maxPromptBytes) { setComposerError(`메시지가 너무 깁니다. ${bootstrap.maxPromptBytes.toLocaleString()}바이트 이내로 줄여 주세요.`); inputRef.current?.focus(); return; }
    const original = messagesRef.current;
    const truncateAt = retryUserIndex ?? editing;
    const prefix = (truncateAt === null || truncateAt === undefined ? original : original.slice(0, truncateAt)).slice(-38);
    const history = boundedHistory(prefix, prompt, bootstrap);
    const user: GuestMessage = retryUserIndex !== undefined ? original[retryUserIndex] : { id: newId(), role: 'user', content: prompt, status: 'complete' };
    if (!user || user.role !== 'user') return;
    const answerId = newId();
    const requestId = newId();
    const epoch = ++epochRef.current;
    speechRef.current?.abort(); speechRef.current = null; setListening(false);
    const controller = new AbortController();
    abortRef.current = controller;
    streamingRef.current = true;
    nearBottomRef.current = true;
    setMessages([...prefix, user, { id: answerId, role: 'assistant', content: '', status: 'streaming' }]);
    if (retryUserIndex === undefined) setDraft('');
    setEditing(null); setComposerError(''); setPopup(null); setStreaming(true);
    let content = '';
    let done = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 125000);
    const current = () => mountedRef.current && epochRef.current === epoch;
    const update = (status: GuestMessage['status'], error?: string) => {
      if (current()) setMessages(previous => previous.map(message => message.id === answerId ? { ...message, content, status, ...(error ? { error } : {}) } : message));
    };
    try {
      const response = await fetch('/api/guest/chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, signal: controller.signal, body: JSON.stringify({ requestId, prompt, history }) });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: string; code?: string; remaining?: number };
        if (current() && typeof failure.remaining === 'number') setBootstrap(previous => previous ? { ...previous, remaining: failure.remaining! } : previous);
        if (failure.code === 'GUEST_SESSION_REQUIRED' && current()) void loadBootstrap();
        if (failure.code === 'GUEST_SITE_LIMIT' && current()) { setBootstrap(previous => previous ? { ...previous, available: false, remaining: 0, error: failure.error, resetsAt: null } : previous); setBootError(failure.error || '현재 체험 서비스를 이용할 수 없습니다.'); }
        throw new Error(failure.error || '답변을 가져올 수 없습니다. 잠시 후 다시 시도해 주세요.');
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('응답 연결이 올바르지 않습니다. 다시 시도해 주세요.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const event = (block: string) => {
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || !current()) return;
        let message: { type?: string; text?: string; remaining?: number; error?: string };
        try { message = JSON.parse(data); } catch { throw new Error('답변을 읽지 못했습니다. 다시 시도해 주세요.'); }
        if (typeof message.remaining === 'number') setBootstrap(previous => previous ? { ...previous, remaining: message.remaining! } : previous);
        if (message.type === 'delta' && typeof message.text === 'string') { content = (content + message.text).slice(0, 32000); update('streaming'); }
        if (message.type === 'done') done = true;
        if (message.type === 'error') throw new Error(message.error || '답변 생성이 중단되었습니다. 다시 시도해 주세요.');
      };
      while (true) {
        const chunk = await reader.read();
        buffer = (buffer + decoder.decode(chunk.value, { stream: !chunk.done })).replace(/\r\n/g, '\n');
        let separator = buffer.indexOf('\n\n');
        while (separator !== -1) { event(buffer.slice(0, separator)); buffer = buffer.slice(separator + 2); separator = buffer.indexOf('\n\n'); }
        if (chunk.done) { if (buffer.trim()) event(buffer); break; }
        if (!current()) { await reader.cancel(); break; }
      }
      if (current()) {
        if (!done || !content.trim()) throw new Error('답변 연결이 끊어졌습니다. 다시 시도해 주세요.');
        update('complete'); setHasInteracted(true); setAnnouncement('답변이 완료되었습니다.');
      }
    } catch (error) {
      if (current()) {
        if (controller.signal.aborted && !timedOut) update('stopped');
        else update('error', timedOut ? '응답 시간이 초과되었습니다. 다시 시도해 주세요.' : error instanceof Error ? error.message : '네트워크 연결을 확인해 주세요.');
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (current()) { streamingRef.current = false; setStreaming(false); abortRef.current = null; }
    }
  }

  function submit() { if (canSubmit) void sendPrompt(draft); }
  function composerKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); submit(); }
  }
  function openModal(next: Modal) { dialogTrigger.current = document.activeElement as HTMLElement | null; setModal(next); }
  function requestNewChat() { if (!empty && !streaming) { setPopup(null); openModal('new-chat'); } }
  function clearChat() {
    epochRef.current++;
    speechRef.current?.abort(); speechRef.current = null; setListening(false);
    setMessages([]); setDraft(''); setEditing(null); setComposerError(''); setSessionId(newId()); setModal(null); setDrawer(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setAnnouncement('복사했습니다.'); }
    catch { setAnnouncement('복사하지 못했습니다. 텍스트를 선택해 복사해 주세요.'); }
    setPopup(null);
  }
  function edit(index: number) { setDraft(messages[index].content); setEditing(index); setComposerError(''); setTimeout(() => inputRef.current?.focus(), 0); }
  async function install() {
    if (!installEvent) return;
    try { await installEvent.prompt(); const choice = await installEvent.userChoice; setInstallMessage(choice.outcome === 'accepted' ? '설치가 시작되었습니다.' : '나중에 브라우저 메뉴에서 설치할 수 있습니다.'); setInstallEvent(null); }
    catch { setInstallMessage('브라우저 메뉴에서 앱 설치 또는 홈 화면에 추가를 선택해 주세요.'); }
  }
  function dictate() {
    if (listening) { speechRef.current?.stop(); return; }
    const speechWindow = window as unknown as { SpeechRecognition?: new () => SpeechRecognizer; webkitSpeechRecognition?: new () => SpeechRecognizer };
    const Speech = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Speech) { setComposerError('이 브라우저는 음성 입력을 지원하지 않습니다. 키보드로 입력해 주세요.'); return; }
    const recognition = new Speech(); speechRef.current = recognition;
    const speechEpoch = epochRef.current;
    const acceptsResult = () => mountedRef.current && epochRef.current === speechEpoch && speechRef.current === recognition;
    recognition.lang = 'ko-KR'; recognition.continuous = false; recognition.interimResults = false;
    recognition.onresult = event => {
      const transcript = Array.from({ length: event.results.length - event.resultIndex }, (_, index) => event.results[event.resultIndex + index][0].transcript).join(' ');
      if (acceptsResult()) setDraft(previous => `${previous}${previous ? ' ' : ''}${transcript}`.slice(0, 8000));
    };
    recognition.onerror = event => { if (acceptsResult()) { setListening(false); setComposerError(event.error === 'not-allowed' ? '음성 입력을 사용하려면 브라우저에서 마이크를 허용해 주세요.' : '음성을 인식하지 못했습니다. 다시 시도하거나 직접 입력해 주세요.'); } };
    recognition.onend = () => { if (mountedRef.current && speechRef.current === recognition) { setListening(false); speechRef.current = null; } };
    try { setComposerError(''); recognition.start(); setListening(true); } catch { setComposerError('음성 입력을 시작하지 못했습니다.'); }
  }

  function modelMenu() {
    return <div className="pg-popover pg-model-menu" role="menu" aria-label="모델 선택">
      <div className="pg-menu-heading">모델</div>
      <button type="button" className="pg-model-option" role="menuitemradio" aria-checked="true" onClick={() => { setPopup(null); popupTrigger.current?.focus(); }}><span><strong>{modelName}</strong><small>로그인 없이 체험</small></span><Check size={18}/></button>
      {[['GPT-6 Astra', '추론'], ['Claude Fable 5.1', '글쓰기와 코딩'], ['Gemini 4 Argon', '긴 문서 이해']].map(([name, description]) => <a key={name} href={signInHref} target="_top" role="menuitem" className="pg-model-option pg-model-locked" onClick={rememberSignIn}><span><strong>{name}</strong><small>{description} · 로그인 후 연결 상태 확인</small></span><LockKeyhole size={15}/></a>)}
      {signIn('pg-menu-signin', '로그인 후 모델 연결 확인', true)}
    </div>;
  }

  function settingsMenu() {
    if (popup === 'theme') return <div className="pg-popover pg-settings-menu" role="menu" aria-label="테마">
      <button type="button" role="menuitem" onClick={() => setPopup('settings')} className="pg-menu-back">‹ 설정으로 돌아가기</button>
      {([['system', '시스템 설정'], ['light', '밝은 테마'], ['dark', '어두운 테마']] as [ThemePreference, string][]).map(([value, label]) => <button type="button" key={value} role="menuitemradio" aria-checked={theme === value} onClick={() => { setTheme(value); setPopup(null); popupTrigger.current?.focus(); }}>{value === 'light' ? <Sun size={18}/> : <Moon size={18}/>}<span>{label}</span>{theme === value && <Check size={17}/>}</button>)}
    </div>;
    return <div className="pg-popover pg-settings-menu" role="menu" aria-label="설정 및 도움말">
      <button type="button" role="menuitem" onClick={() => setPopup('theme')}><Moon size={18}/><span>테마</span><ChevronRight size={16}/></button>
      <a href={signInHref} target="_top" role="menuitem" onClick={rememberSignIn}><Settings size={18}/><span>계정 및 연결 설정</span><LockKeyhole size={15}/></a>
      <a href="/help" role="menuitem"><HelpCircle size={18}/><span>도움말</span></a>
      <div className="pg-menu-divider"/>
      <a href="/privacy" role="menuitem">개인정보 처리방침</a>
      <a href="/terms" role="menuitem">이용약관</a>
    </div>;
  }

  const sidebarContent = <>
    <div className="pg-sidebar-brand"><a href="/" aria-label="OpenPrism 홈"><PrismMark/><span>OpenPrism</span></a><button className="pg-icon-button pg-collapse-button" type="button" onClick={() => setCollapsed(true)} aria-label="사이드바 접기"><Menu size={19}/></button><button className="pg-icon-button pg-drawer-close" type="button" data-drawer-close onClick={() => setDrawer(false)} aria-label="메뉴 닫기"><X size={20}/></button></div>
    <div className="pg-sidebar-top"><button className="pg-sidebar-row" type="button" disabled={empty || streaming} onClick={requestNewChat}><SquarePen size={18}/><span>새 채팅</span></button><a className="pg-sidebar-row" href={signInHref} target="_top" onClick={rememberSignIn}><ImagePlus size={18}/><span>이미지 생성</span><LockKeyhole size={13} className="pg-trailing-icon"/></a><p className="pg-sidebar-note">로그인하면 대화를 저장하고<br/>더 많은 기능을 사용할 수 있어요.</p></div>
    <div className="pg-sidebar-bottom"><a className="pg-sidebar-row" href="/about"><Sparkles size={17}/><span>OpenPrism 소개</span></a><a className="pg-sidebar-row" href="/faq"><HelpCircle size={17}/><span>자주 묻는 질문</span></a><div className="pg-settings-anchor"><button className="pg-sidebar-row" type="button" data-popup-trigger aria-haspopup="menu" aria-expanded={popup === 'settings' || popup === 'theme'} onClick={event => togglePopup('settings', event.currentTarget)}><Settings size={17}/><span>설정 및 도움말</span></button>{(popup === 'settings' || popup === 'theme') && settingsMenu()}</div>{signIn('pg-sidebar-signin')}<button className="pg-sidebar-install" type="button" onClick={() => { setPopup(null); openModal('install'); }}><Download size={16}/>앱 다운로드</button></div>
  </>;

  return <div ref={rootRef} className={`prism-guest ${empty ? 'pg-is-empty' : 'pg-has-chat'} ${collapsed ? 'pg-is-collapsed' : ''}`}>
    <a className="pg-skip-link" href="#pg-prompt">메시지 입력으로 이동</a>
    <aside className="pg-sidebar" aria-label="주 탐색" inert={drawer || modal ? true : undefined}>{sidebarContent}</aside>
    {drawer && <div className="pg-drawer-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) setDrawer(false); }}><aside ref={drawerRef} className="pg-drawer" inert={modal ? true : undefined} role="dialog" aria-modal="true" aria-label="주 메뉴">{sidebarContent}</aside></div>}
    <div className="pg-main" inert={drawer || modal ? true : undefined}>
      <header className="pg-header">
        <div className="pg-header-start"><button type="button" className="pg-icon-button pg-mobile-menu" aria-label="메뉴 열기" aria-expanded={drawer} onClick={() => setDrawer(true)}><Menu size={22}/></button>{collapsed && <button type="button" className="pg-icon-button pg-desktop-menu" aria-label="사이드바 펼치기" onClick={() => setCollapsed(false)}><Menu size={22}/></button>}<a className="pg-header-brand" href="/" aria-label="OpenPrism 홈"><PrismMark/><span>OpenPrism</span></a><div className="pg-mobile-model-anchor"><button type="button" className="pg-model-trigger" data-popup-trigger aria-haspopup="menu" aria-expanded={popup === 'model'} onClick={event => togglePopup('model', event.currentTarget)}><span>{modelName}</span><ChevronDown size={14}/></button>{popup === 'model' && isMobile && modelMenu()}</div></div>
        <div className="pg-header-actions"><button type="button" className="pg-icon-button pg-mobile-new" disabled={empty || streaming} onClick={requestNewChat} aria-label="새 채팅"><SquarePen size={20}/></button>{empty && <button type="button" className="pg-header-download" onClick={() => openModal('install')}><Download size={16}/>앱 다운로드</button>}{signIn('pg-signin-button')}</div>
      </header>
      <div className="pg-chat-scroll" ref={scrollRef} onScroll={event => { const target = event.currentTarget; nearBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 100; }}>
        {empty ? <section className="pg-welcome" aria-labelledby="pg-welcome-title"><h1 id="pg-welcome-title">안녕하세요,<br/><span>무엇을 도와드릴까요?</span></h1></section> : <section className="pg-conversation" aria-label="체험 대화">
          {messages.map((message, index) => message.role === 'user' ? <div className="pg-user-row" key={message.id}><div className="pg-user-bubble">{message.content}</div><div className="pg-user-actions"><button type="button" className="pg-icon-button" aria-label="질문 복사" title="질문 복사" onClick={() => void copy(message.content)}><Copy size={16}/></button><button type="button" className="pg-icon-button" aria-label="질문 수정" title="질문 수정" disabled={streaming} onClick={() => edit(index)}><Pencil size={16}/></button></div></div> : <div className="pg-assistant" key={message.id}><div className="pg-answer-mark"><PrismMark size={24}/></div><div className="pg-answer-content">
            {message.content && <GuestMarkdown text={message.content}/>}
            {message.status === 'streaming' && !message.content && <div className="pg-thinking" role="status"><span/><span/><span/><span className="pg-sr-only">답변 생성 중</span></div>}
            {message.status === 'stopped' && <p className="pg-answer-status">답변 생성이 중지되었습니다.</p>}
            {message.status === 'error' && <p className="pg-answer-error" role="alert">{message.error || '답변을 가져오지 못했습니다.'}</p>}
            {message.status !== 'streaming' && <div className="pg-response-actions">{message.content && <button type="button" className="pg-icon-button" aria-label="답변 복사" title="답변 복사" onClick={() => void copy(message.content)}><Copy size={17}/></button>}<button type="button" className="pg-icon-button" aria-label="답변 다시 생성" title="답변 다시 생성" disabled={streaming || unavailable || bootLoading} onClick={() => void sendPrompt(messages[index - 1]?.content || '', index - 1)}><RefreshCw size={17}/></button><div className="pg-response-menu-anchor"><button type="button" className="pg-icon-button" data-popup-trigger aria-label="답변 더보기" aria-haspopup="menu" aria-expanded={popup === `response-${message.id}`} onClick={event => togglePopup(`response-${message.id}`, event.currentTarget)}><MoreHorizontal size={20}/></button>{popup === `response-${message.id}` && <div className="pg-popover pg-response-menu" role="menu" aria-label="답변 메뉴">{message.content && <button type="button" role="menuitem" onClick={() => void copy(message.content)}><Copy size={17}/>답변 복사</button>}<button type="button" role="menuitem" disabled={streaming || unavailable || bootLoading} onClick={() => void sendPrompt(messages[index - 1]?.content || '', index - 1)}><RefreshCw size={17}/>다시 생성</button><a href="/help" role="menuitem"><HelpCircle size={17}/>도움말</a></div>}</div></div>}
          </div></div>)}
          <p className="pg-accuracy">OpenPrism은 실수할 수 있습니다. 중요한 정보는 확인해 주세요.</p>
        </section>}
      </div>
      <div className="pg-compose-area">
        {hasInteracted && !streaming && <aside className="pg-signin-reminder"><p>대화를 저장하고 더 많은 기능을<br className="pg-reminder-break"/> 사용하려면 로그인하세요.</p>{signIn('pg-reminder-signin')}</aside>}
        {(bootError || (bootstrap?.available && bootstrap.remaining <= 0)) && <div className="pg-service-notice" role="status"><span>{bootError || '오늘의 체험 횟수를 모두 사용했습니다.'}</span>{bootError ? <button type="button" disabled={bootLoading} onClick={() => void loadBootstrap()}>{bootLoading ? '연결 중…' : '다시 연결'}</button> : signIn('', '로그인')}</div>}
        {editing !== null && <div className="pg-edit-notice"><span>질문 수정 · 전송하면 이후 대화가 새로 생성됩니다.</span><button type="button" onClick={() => { setEditing(null); setDraft(''); }} aria-label="수정 취소"><X size={16}/></button></div>}
        {composerError && <div className="pg-composer-error" role="alert">{composerError}</div>}
        <form className={`pg-composer ${listening ? 'pg-is-listening' : ''}`} onSubmit={event => { event.preventDefault(); submit(); }}>
          <div className="pg-tools-anchor"><button type="button" className="pg-icon-button pg-add-button" data-popup-trigger aria-label="도구 및 파일" aria-haspopup="menu" aria-expanded={popup === 'tools'} onClick={event => togglePopup('tools', event.currentTarget)}><Plus size={24}/></button>{popup === 'tools' && <div className="pg-popover pg-tools-menu" role="menu" aria-label="도구 및 파일"><div className="pg-menu-heading">로그인하여 사용</div><a href={signInHref} target="_top" role="menuitem" onClick={rememberSignIn}><FilePlus2 size={18}/><span>파일 추가</span><LockKeyhole size={14}/></a><div className="pg-menu-divider"/><a href={signInHref} target="_top" role="menuitem" onClick={rememberSignIn}><ImagePlus size={18}/><span>이미지 생성</span><LockKeyhole size={14}/></a><a href={signInHref} target="_top" role="menuitem" onClick={rememberSignIn}><SquarePen size={18}/><span>문서 작업</span><LockKeyhole size={14}/></a><a href={signInHref} target="_top" role="menuitem" onClick={rememberSignIn}><Sparkles size={18}/><span>워크스페이스 도구</span><LockKeyhole size={14}/></a>{signIn('pg-menu-signin', '로그인하여 계속하기', true)}</div>}</div>
          <label className="pg-sr-only" htmlFor="pg-prompt">OpenPrism에 메시지 보내기</label><textarea id="pg-prompt" ref={inputRef} value={draft} onChange={event => { setDraft(event.target.value); if (composerError) setComposerError(''); }} onKeyDown={composerKey} placeholder="OpenPrism에게 물어보세요" rows={1} maxLength={8000} disabled={!ready} aria-describedby="pg-input-help"/>
          <div className="pg-desktop-model-anchor"><button type="button" className="pg-model-trigger" data-popup-trigger aria-haspopup="menu" aria-expanded={popup === 'model'} onClick={event => togglePopup('model', event.currentTarget)}><span>{modelName}</span><ChevronDown size={14}/></button>{popup === 'model' && !isMobile && modelMenu()}</div>
          {streaming ? <button type="button" className="pg-submit pg-stop" aria-label="답변 생성 중지" title="답변 생성 중지" onClick={stop}><Square size={17} fill="currentColor"/></button> : draft.trim() ? <button type="submit" className="pg-submit" disabled={!canSubmit} aria-label="메시지 보내기" title="메시지 보내기">{bootLoading ? <LoaderCircle size={20} className="pg-spin"/> : <ArrowUp size={22}/>}</button> : <button type="button" className="pg-icon-button pg-mic" aria-label={listening ? '음성 입력 중지' : '음성 입력'} aria-pressed={listening} title="음성 입력" disabled={!ready} onClick={dictate}><Mic size={22}/></button>}
        </form>
        <p id="pg-input-help" className="pg-sr-only">Enter로 전송하고 Shift와 Enter로 줄을 바꿀 수 있습니다. 체험 대화는 이 탭에 임시로 보관됩니다.</p>
        <footer className="pg-footer"><span>로그인 전 대화는 임시 보관됩니다.</span> <a href="/privacy">개인정보 처리방침</a><span aria-hidden="true"> · </span><a href="/terms">이용약관</a></footer>
      </div>
    </div>
    {modal === 'new-chat' && <GuestDialog returnFocus={dialogTrigger.current} title="새 채팅을 시작할까요?" onClose={() => setModal(null)} className="pg-new-chat-dialog"><p>현재 대화는 저장되지 않았습니다.<br/>새 채팅을 시작하면 이 대화가<br/>삭제됩니다.</p><div className="pg-dialog-actions"><button type="button" data-initial-focus className="pg-dialog-cancel" onClick={() => setModal(null)}>취소</button><button type="button" className="pg-dialog-primary" onClick={clearChat}>새 채팅</button></div></GuestDialog>}
    {modal === 'install' && <GuestDialog returnFocus={dialogTrigger.current} title="OpenPrism 앱 설치" onClose={() => setModal(null)}><p>OpenPrism을 홈 화면이나 데스크톱에 추가하면 앱처럼 바로 열 수 있습니다.</p>{installEvent ? <button className="pg-install-action" type="button" onClick={() => void install()}><Download size={18}/>이 기기에 설치</button> : <div className="pg-install-instructions"><p><strong>Chrome · Edge</strong><br/>브라우저 메뉴에서 ‘설치’ 또는 ‘앱으로 설치’를 선택해 주세요.</p><p><strong>iPhone · iPad</strong><br/>Safari의 공유 메뉴에서 ‘홈 화면에 추가’를 선택해 주세요.</p><p>설치 메뉴가 없으면 이 페이지를 북마크해 이용할 수 있습니다.</p></div>}{installMessage && <p role="status">{installMessage}</p>}<div className="pg-dialog-actions"><button type="button" data-initial-focus className="pg-dialog-primary" onClick={() => setModal(null)}>닫기</button></div></GuestDialog>}
    <div className="pg-sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
    {announcement && <div className="pg-toast" aria-hidden="true">{announcement}</div>}
  </div>;
}
