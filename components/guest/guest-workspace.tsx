'use client';
import { isNewChatShortcut } from '../../lib/workspace-navigation';
import { readChatStream } from '../../lib/chat-stream';
import { AVAILABLE_CHAT_MODELS, DEFAULT_MODEL_ID, findModel, isFreeModel } from '../../lib/models';

import { lazy, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { usePathname } from 'next/navigation';
import { useCopyFeedback } from '../../hooks/use-copy-feedback';
import { useShellPerformance } from '../../hooks/use-shell-performance';
import { useStaticAssetCache } from '../../hooks/use-static-asset-cache';
import { PrismMark } from '../brand/prism-mark';
import { ArrowUp, Check, ChevronRight, Copy, Download, FilePlus2, HelpCircle, ImagePlus, LoaderCircle, LockKeyhole, Menu, Mic, Moon, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RefreshCw, Settings, Sparkles, Square, SquarePen, Sun, X } from 'lucide-react';
import { useWorkspaceTheme, type ThemePreference } from '../workspace/theme';
import { readGuestSession, writeGuestSession, type GuestMessage, type GuestSession } from '../../lib/guest-session';
import { advanceGuestSignInReminder, guestSignInReminderReason, markGuestSignInReminderShown, readGuestSignInReminder, writeGuestSignInReminder, type GuestSignInReminderReason, type GuestSignInReminderState } from '../../lib/guest-signin-reminder';
import { conversationMarkdown } from '../../lib/conversation-export';
import { ConversationActions } from '../workspace/conversation-actions';
import { ResponseActions, type RegenerateStyle, type ResponseFeedback } from '../workspace/response-actions';
import { ThinkingIndicator } from '../workspace/thinking-indicator';
import { useWelcomeIntro } from '../workspace/welcome-intro';
import type { DetailTarget, ExportTarget } from '../workspace/conversation-tools';
import { DeferredPanel } from '../workspace/deferred-panel';
import GuestMarkdown from './guest-markdown';
import GuestDialog from './guest-dialog';
import GuestSignInDialog from './guest-signin-dialog';
import { GuestModelPicker } from './guest-model-picker';
import CollapsiblePrompt from '../chat/collapsible-prompt';

const ExportDialog = lazy(() => import('../workspace/conversation-tools').then(module => ({ default: module.ExportDialog })));
const ResponseDetailsDialog = lazy(() => import('../workspace/conversation-tools').then(module => ({ default: module.ResponseDetailsDialog })));
const LegalReportDialog = lazy(() => import('../workspace/conversation-tools').then(module => ({ default: module.LegalReportDialog })));

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
type Popup = 'tools' | 'model' | 'settings' | 'theme' | null;
type Modal = 'new-chat' | 'delete-chat' | 'rename-chat' | 'pin-chat' | 'install' | 'sign-in' | null;
type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
type SpeechResultEvent = { results: { [index: number]: { [index: number]: { transcript: string }; isFinal: boolean }; length: number }; resultIndex: number };
type SpeechRecognizer = { lang: string; continuous: boolean; interimResults: boolean; onresult: ((event: SpeechResultEvent) => void) | null; onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null; start(): void; stop(): void; abort(): void };

const DEFAULT_MODEL = findModel(DEFAULT_MODEL_ID)!.name;
const RESPONSE_COMPLETE_ANNOUNCEMENT = '답변이 완료되었습니다.';
const bytes = (value: string) => new TextEncoder().encode(value).length;
function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const random = crypto.getRandomValues(new Uint8Array(16));
  random[6] = (random[6] & 0x0f) | 0x40;
  random[8] = (random[8] & 0x3f) | 0x80;
  const hex = [...random].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
  useShellPerformance();
  useStaticAssetCache();
  const pathname = usePathname();
  const { theme, setTheme } = useWorkspaceTheme();
  const [messages, setMessages] = useState<GuestMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [sessionTitle, setSessionTitle] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState('');
  const [pdfBusy, setPdfBusy] = useState(false);
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  const [reportTarget, setReportTarget] = useState<DetailTarget | null>(null);
  const [ready, setReady] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [popup, setPopup] = useState<Popup>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [signInReminder, setSignInReminder] = useState<GuestSignInReminderState | null>(null);
  const [signInReason, setSignInReason] = useState<GuestSignInReminderReason>('encouragement');
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [composerError, setComposerError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const { copy: copyText, isCopied, copyNotice, copyNoticeKey, resetCopyFeedback } = useCopyFeedback(sessionId, setAnnouncement, id => messages.find(message => message.id === id)?.content);
  const toastNotice = copyNotice || (announcement === RESPONSE_COMPLETE_ANNOUNCEMENT ? '' : announcement);
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [installMessage, setInstallMessage] = useState('');
  const [listening, setListening] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const desktopMenuRef = useRef<HTMLButtonElement>(null);
  const desktopCollapseRef = useRef<HTMLButtonElement>(null);
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
  const newChatAction = useRef(requestNewChat);
  newChatAction.current = requestNewChat;
  surfaceRef.current = { popup, modal };
  messagesRef.current = messages;
  const empty = messages.length === 0;
  const welcomePhase = useWelcomeIntro({ active: empty, ready });
  const conversationTitle = sessionTitle || messages.find(message => message.role === 'user')?.content.replace(/\s+/g, ' ').slice(0, 80) || '새 채팅';
  const lastAssistantIndex = messages.findLastIndex(message => message.role === 'assistant');
  const modelName = bootstrap?.model.name || DEFAULT_MODEL;
  const unavailable = !bootstrap?.available || bootstrap.remaining <= 0;
  const canSubmit = ready && !bootLoading && !unavailable && !!draft.trim() && !streaming;

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!isNewChatShortcut(event)) return;
      event.preventDefault(); event.stopPropagation(); newChatAction.current();
    };
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  }, []);

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
    const completedPromptIds = (restored?.messages || []).filter((message, index, history) => message.role === 'user' && history[index + 1]?.role === 'assistant' && history[index + 1]?.status === 'complete' && history[index + 1]?.content.trim()).map(message => message.id);
    setSignInReminder(readGuestSignInReminder(completedPromptIds));
    setSessionId(restored?.id || newId());
    if (restored) { setMessages(restored.messages); setDraft(restored.draft); setHasInteracted(restored.hasInteracted); setSessionTitle(restored.title || ''); }
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
    writeGuestSession({ id: sessionId, messages, draft, savedAt: Date.now(), hasInteracted, title: sessionTitle });
  }, [ready, sessionId, messages, draft, hasInteracted, sessionTitle]);

  useEffect(() => {
    if (signInReminder) writeGuestSignInReminder(signInReminder);
  }, [signInReminder]);

  useEffect(() => {
    if (!ready || bootLoading || streaming || listening || modal || drawer || popup || exportTarget || detailTarget || reportTarget || !signInReminder) return;
    const reason = guestSignInReminderReason(signInReminder, bootstrap);
    if (!reason) return;
    const next = markGuestSignInReminderShown(signInReminder, reason);
    // Persist when displayed, so a refresh or new chat cannot immediately repeat it.
    writeGuestSignInReminder(next);
    setSignInReminder(next);
    dialogTrigger.current = inputRef.current;
    inputRef.current?.blur();
    setSignInReason(reason);
    setModal('sign-in');
  }, [ready, bootLoading, streaming, listening, modal, drawer, popup, exportTarget, detailTarget, reportTarget, signInReminder, bootstrap]);

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
    // The model picker owns its positioned portal and keyboard lifecycle.
    if (!popup || popup === 'model') return;
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
      const preferBelow = headerMenu || (empty && trigger.closest('.pg-composer'));
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

  function toggleDesktopSidebar(next: boolean) {
    setPopup(null);
    setCollapsed(next);
    requestAnimationFrame(() => (next ? desktopMenuRef.current : desktopCollapseRef.current)?.focus());
  }

  function rememberSignIn() {
    speechRef.current?.abort(); speechRef.current = null; setListening(false);
    const interrupted = streamingRef.current;
    const currentMessages = messagesRef.current.map(message => message.status === 'streaming' ? { ...message, status: 'stopped' as const } : message);
    const latestQuestion = [...currentMessages].reverse().find(message => message.role === 'user');
    const resumedDraft = draft.trim() ? draft : interrupted ? latestQuestion?.content || '' : draft;
    if (interrupted) stop();
    const snapshot: GuestSession = { id: sessionId, messages: currentMessages, draft: resumedDraft, hasInteracted, savedAt: Date.now(), title: sessionTitle };
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

  async function sendPrompt(value: string, retryUserIndex?: number, regenerateStyle?: RegenerateStyle) {
    const prompt = value.trim();
    if (!prompt || streamingRef.current || !bootstrap?.available || bootstrap.remaining <= 0) return;
    if (bytes(prompt) > bootstrap.maxPromptBytes) { setComposerError(`메시지가 너무 깁니다. ${bootstrap.maxPromptBytes.toLocaleString()}바이트 이내로 줄여 주세요.`); inputRef.current?.focus(); return; }
    const original = messagesRef.current;
    const truncateAt = retryUserIndex ?? editing;
    const isNewPrompt = retryUserIndex === undefined && editing === null;
    const prefix = (truncateAt === null || truncateAt === undefined ? original : original.slice(0, truncateAt)).slice(-38);
    const history = boundedHistory(prefix, prompt, bootstrap);
    const user: GuestMessage = retryUserIndex !== undefined ? original[retryUserIndex] : { id: newId(), role: 'user', content: prompt, status: 'complete', created_at: Date.now() };
    if (!user || user.role !== 'user') return;
    const answerId = newId();
    const requestId = newId();
    const epoch = ++epochRef.current;
    speechRef.current?.abort(); speechRef.current = null; setListening(false);
    const controller = new AbortController();
    abortRef.current = controller;
    streamingRef.current = true;
    nearBottomRef.current = true;
    let responseModel = bootstrap.model.id;
    setMessages([...prefix, user, { id: answerId, role: 'assistant', content: '', status: 'streaming', model: responseModel, created_at: Date.now() }]);
    if (retryUserIndex === undefined) setDraft('');
    setEditing(null); setComposerError(''); setPopup(null); setStreaming(true);
    let content = '';
    let done = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 125000);
    const current = () => mountedRef.current && epochRef.current === epoch;
    const update = (status: GuestMessage['status'], error?: string) => {
      if (current()) setMessages(previous => previous.map(message => message.id === answerId ? { ...message, content, status, model: responseModel, ...(error ? { error } : {}) } : message));
    };
    try {
      const response = await fetch('/api/guest/chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, signal: controller.signal, body: JSON.stringify({ requestId, prompt, history, ...(retryUserIndex !== undefined && regenerateStyle ? { regenerateStyle } : {}) }) });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: string; code?: string; remaining?: number };
        if (current() && typeof failure.remaining === 'number') setBootstrap(previous => previous ? { ...previous, remaining: failure.remaining! } : previous);
        if (failure.code === 'GUEST_SESSION_REQUIRED' && current()) void loadBootstrap();
        if (failure.code === 'GUEST_SITE_LIMIT' && current()) { setBootstrap(previous => previous ? { ...previous, available: false, remaining: 0, error: failure.error, resetsAt: null } : previous); setBootError(failure.error || '현재 체험 서비스를 이용할 수 없습니다.'); }
        throw new Error(failure.error || '답변을 가져올 수 없습니다. 잠시 후 다시 시도해 주세요.');
      }
      await readChatStream(response, { signal: controller.signal, onEvent: message => {
        if (!current()) return;
        if ((message.type === 'start' || message.type === 'done') && typeof message.model === 'string' && message.model.length <= 120) responseModel = message.model;
        if (typeof message.remaining === 'number') setBootstrap(previous => previous ? { ...previous, remaining: message.remaining } : previous);
        if (message.type === 'delta' && typeof message.text === 'string') { content = (content + message.text).slice(0, 32000); update('streaming'); }
        if (message.type === 'replace' && typeof message.text === 'string') { content = message.text.slice(0, 32000); update('streaming'); }
        if (message.type === 'done') done = true;
      } });
      if (current()) {
        if (!done || !content.trim()) throw new Error('답변 연결이 끊어졌습니다. 다시 시도해 주세요.');
        update('complete'); setHasInteracted(true); setAnnouncement(RESPONSE_COMPLETE_ANNOUNCEMENT);
        setSignInReminder(previous => advanceGuestSignInReminder(previous || readGuestSignInReminder(), { promptId: user.id, status: 'complete', isNewPrompt }));
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
  function requestNewChat() {
    if (modal || exportTarget || detailTarget || reportTarget) return;
    setPopup(null);
    if (!empty || draft.trim()) openModal('new-chat');
    else clearChat();
  }
  function clearChat() {
    resetCopyFeedback();
    setHasInteracted(false); setAnnouncement('');
    epochRef.current++;
    abortRef.current?.abort(); abortRef.current = null;
    streamingRef.current = false; setStreaming(false);
    speechRef.current?.abort(); speechRef.current = null; setListening(false);
    setMessages([]); setDraft(''); setEditing(null); setComposerError(''); setSessionId(newId()); setSessionTitle(''); setModal(null); setDrawer(false); setPopup(null); setExportTarget(null); setDetailTarget(null); setReportTarget(null);
    if (window.location.pathname !== '/chat') window.history.pushState(window.history.state, '', '/chat');
    setTimeout(() => inputRef.current?.focus(), 0);
  }
  async function copy(message: GuestMessage) {
    setPopup(null);
    await copyText(message.id, message.content, message.role === 'user' ? '프롬프트가 복사되었습니다.' : '대화가 복사되었습니다.');
  }
  function setFeedback(messageId: string, feedback: ResponseFeedback, details?: string) {
    const target = messagesRef.current.find(message => message.id === messageId && message.role === 'assistant' && message.status === 'complete');
    if (!target) return;
    const feedbackDetails = feedback === 'down' && details?.trim() ? details.trim().slice(0, 2000) : undefined;
    const next = messagesRef.current.map(message => message.id === messageId ? { ...message, feedback, feedbackDetails } : message);
    const saved = writeGuestSession({ id: sessionId, messages: next, draft, hasInteracted, title: sessionTitle, savedAt: Date.now() });
    if (!saved) throw new Error('이 브라우저에 의견을 저장하지 못했습니다. 브라우저 저장소 설정을 확인해 주세요.');
    setMessages(current => current.map(message => message.id === messageId ? { ...message, feedback, feedbackDetails } : message));
    setAnnouncement(feedback ? '이 브라우저에 의견을 저장했습니다.' : '의견 선택을 해제했습니다.');
  }
  function responseDetails(message: GuestMessage): DetailTarget {
    return { id: message.id, content: message.content, ...(message.model ? { model: message.model } : {}), ...(message.created_at ? { created_at: message.created_at } : {}) };
  }
  function exportResponse(message: GuestMessage, kind: ExportTarget['kind']) {
    setPopup(null);
    setExportTarget({ title: conversationTitle, content: message.content, kind });
  }
  function renameChat(event: React.FormEvent) {
    event.preventDefault();
    const title = renameDraft.trim().slice(0, 120);
    if (!title) { setRenameError('대화 이름을 입력해 주세요.'); return; }
    if (!writeGuestSession({ id: sessionId, messages: messagesRef.current, draft, hasInteracted, title, savedAt: Date.now() })) {
      setRenameError('이 브라우저에 이름을 저장하지 못했습니다. 브라우저 저장소 설정을 확인해 주세요.');
      return;
    }
    setSessionTitle(title); setModal(null); setAnnouncement('이 브라우저에서 대화 이름을 변경했습니다.');
  }
  async function downloadPdf() {
    if (pdfBusy || streaming) return;
    const snapshot = { title: conversationTitle, messages: messagesRef.current };
    setPdfBusy(true);
    try {
      const { downloadConversationPdf } = await import('../../lib/print-conversation');
      if (!mountedRef.current) return;
      await downloadConversationPdf(snapshot);
    }
    catch (error) { if (mountedRef.current) setAnnouncement(error instanceof Error ? error.message : 'PDF를 만들지 못했습니다. 다시 시도해 주세요.'); }
    finally { if (mountedRef.current) setPdfBusy(false); }
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

  function modelPicker(mobile: boolean) {
    return <GuestModelPicker
      modelName={modelName}
      triggerLabel="Flash-Lite"
      freeDescription="무료 · 로그인 전후 이용 가능"
      lockedModels={AVAILABLE_CHAT_MODELS.filter(model => !isFreeModel(model.id)).map(model => ({ id: model.id, name: model.name, description: '유료 · 로그인 후 크레딧 충전 필요' }))}
      open={popup === 'model' && mobile === isMobile}
      onOpenChange={open => setPopup(current => open ? 'model' : current === 'model' ? null : current)}
      signInHref={signInHref}
      onSignIn={rememberSignIn}
      container={rootRef.current}
      mobile={mobile}
      empty={empty}
    />;
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
    <div className="pg-sidebar-brand"><a href="/" aria-label="Prism 홈"><PrismMark/><span>Prism</span></a><button ref={isMobile ? undefined : desktopCollapseRef} className="pg-icon-button pg-collapse-button" type="button" onClick={() => toggleDesktopSidebar(true)} aria-label="사이드바 접기" aria-controls="pg-desktop-sidebar" aria-expanded={!collapsed}><PanelLeftClose size={19}/></button><button className="pg-icon-button pg-drawer-close" type="button" data-drawer-close onClick={() => setDrawer(false)} aria-label="메뉴 닫기"><X size={20}/></button></div>
    <div className="pg-sidebar-top"><button className="pg-sidebar-row" type="button" disabled={empty && !draft.trim()} onClick={requestNewChat} title="새 채팅 (Ctrl+Shift+O)" aria-keyshortcuts="Control+Shift+O Meta+Shift+O"><SquarePen size={18}/><span>새 채팅</span></button><a className="pg-sidebar-row" href={signInHref} target="_top" onClick={rememberSignIn}><ImagePlus size={18}/><span>이미지 생성</span><LockKeyhole size={13} className="pg-trailing-icon"/></a><p className="pg-sidebar-note">로그인하면 대화를 저장하고<br/>더 많은 기능을 사용할 수 있어요.</p></div>
    <div className="pg-sidebar-bottom"><a className="pg-sidebar-row pg-mobile-info-link" href="/about"><Sparkles size={17}/><span>OpenPrism 소개</span></a><a className="pg-sidebar-row pg-mobile-info-link" href="/faq"><HelpCircle size={17}/><span>자주 묻는 질문</span></a><div className="pg-settings-anchor"><button className="pg-sidebar-row" type="button" data-popup-trigger aria-haspopup="menu" aria-expanded={popup === 'settings' || popup === 'theme'} onClick={event => togglePopup('settings', event.currentTarget)}><Settings size={17}/><span>설정 및 도움말</span></button>{(popup === 'settings' || popup === 'theme') && settingsMenu()}</div>{signIn('pg-sidebar-signin')}<button className="pg-sidebar-install" type="button" onClick={() => { setPopup(null); openModal('install'); }}><Download size={16}/>앱 다운로드</button></div>
  </>;

  return <div ref={rootRef} className={`prism-guest ${empty ? 'pg-is-empty' : 'pg-has-chat'} ${collapsed ? 'pg-is-collapsed' : ''}`}>
    <a className="pg-skip-link" href="#pg-prompt">메시지 입력으로 이동</a>
    <aside id="pg-desktop-sidebar" className="pg-sidebar" aria-label="주 탐색" aria-hidden={collapsed && !isMobile ? true : undefined} inert={drawer || modal || (collapsed && !isMobile) ? true : undefined}><div className="pg-sidebar-content">{sidebarContent}</div></aside>
    {drawer && <div className="pg-drawer-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) setDrawer(false); }}><aside ref={drawerRef} className="pg-drawer" inert={modal ? true : undefined} role="dialog" aria-modal="true" aria-label="주 메뉴">{sidebarContent}</aside></div>}
    <div className="pg-main" data-welcome-phase={welcomePhase} inert={drawer || modal ? true : undefined}>
      <header className="pg-header">
        <div className="pg-header-start"><button type="button" className="pg-icon-button pg-mobile-menu" aria-label="메뉴 열기" aria-expanded={drawer} onClick={() => setDrawer(true)}><Menu size={22}/></button><button ref={desktopMenuRef} type="button" className="pg-icon-button pg-desktop-menu" aria-label="사이드바 펼치기" aria-controls="pg-desktop-sidebar" aria-expanded={!collapsed} aria-hidden={!collapsed} tabIndex={collapsed ? 0 : -1} onClick={() => toggleDesktopSidebar(false)}><PanelLeftOpen size={22}/></button><a className="pg-header-brand" href="/" aria-label="Prism 홈" aria-hidden={!collapsed} tabIndex={collapsed ? 0 : -1}><PrismMark/><span>Prism</span></a><div className="pg-mobile-model-anchor">{modelPicker(true)}</div></div>
        <div className="pg-header-actions">
          <nav className="pg-header-links" aria-label="OpenPrism 안내"><a href="/about">OpenPrism 소개</a><a href="/faq">자주 묻는 질문</a></nav>
          <button type="button" className="pg-icon-button pg-mobile-new" disabled={empty && !draft.trim()} onClick={requestNewChat} title="새 채팅 (Ctrl+Shift+O)" aria-keyshortcuts="Control+Shift+O Meta+Shift+O" aria-label="새 채팅"><SquarePen size={20}/></button>
          {!empty && <ConversationActions title={conversationTitle} variant="header" disabled={streaming} exportBusy={pdfBusy}
            onPin={() => openModal('pin-chat')}
            onRename={() => { setRenameDraft(conversationTitle); setRenameError(''); openModal('rename-chat'); }}
            onDownloadPdf={downloadPdf}
            onExportDocs={() => setExportTarget({ title: conversationTitle, content: conversationMarkdown(conversationTitle, messagesRef.current), kind: 'docs' })}
            onDelete={() => openModal('delete-chat')}
          />}
          {empty && <button type="button" className="pg-header-download" onClick={() => openModal('install')}><Download size={16}/>앱 다운로드</button>}{signIn('pg-signin-button')}
        </div>
      </header>
      <div className="pg-chat-scroll" ref={scrollRef} onScroll={event => { const target = event.currentTarget; nearBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 100; }}>
        {empty ? <section className="pg-welcome" aria-labelledby="pg-welcome-title"><h1 id="pg-welcome-title"><span className="pg-mobile-greeting">안녕하세요,<br/></span><span>무엇을 도와드릴까요?</span></h1></section> : <section className="pg-conversation" aria-label="체험 대화">
          {messages.map((message, index) => message.role === 'user' ? <div className="pg-user-row" key={message.id}>
            <div className="pg-user-bubble" tabIndex={0} aria-label="내 프롬프트" onPointerUp={event => { if (!(event.target as HTMLElement).closest('button')) event.currentTarget.focus({ preventScroll: true }); }}><CollapsiblePrompt text={message.content}/></div>
            <div className="pg-user-actions">
              <button type="button" className="pg-icon-button" data-copied={isCopied(message.id, message.content)} aria-label={isCopied(message.id, message.content) ? '프롬프트 복사됨' : '프롬프트 복사'} title={isCopied(message.id, message.content) ? '복사됨' : '프롬프트 복사'} onClick={() => void copy(message)}>{isCopied(message.id, message.content) ? <Check size={16}/> : <Copy size={16}/>}</button>
              <button type="button" className="pg-icon-button" aria-label="질문 수정" title="질문 수정" disabled={streaming} onClick={() => edit(index)}><Pencil size={16}/></button>
            </div>
          </div> : <div className="pg-assistant" key={message.id} data-streaming={message.status === 'streaming' ? 'true' : undefined}>
            <div className="pg-answer-content">
              {message.content && <GuestMarkdown text={message.content}/>}
              {message.status === 'streaming' && !message.content && <ThinkingIndicator/>}
              {message.status === 'stopped' && <p className="pg-answer-status">답변 생성이 중지되었습니다.</p>}
              {message.status === 'error' && <p className="pg-answer-error" role="alert">{message.error || '답변을 가져오지 못했습니다.'}</p>}
              {message.status === 'complete' && message.content && <ResponseActions
                messageId={message.id} content={message.content} scope={`${pathname}:${sessionId}`}
                copied={isCopied(message.id, message.content)} feedback={message.feedback || null} feedbackDestination="browser"
                isLatest={index === lastAssistantIndex} regenerateDisabled={streaming || unavailable || bootLoading}
                onCopy={() => copy(message)} onFeedback={(value, details) => setFeedback(message.id, value, details)}
                onRegenerate={style => sendPrompt(messages[index - 1]?.content || '', index - 1, style)}
                onExportDocs={() => exportResponse(message, 'docs')}
                onCreateGmailDraft={() => exportResponse(message, 'gmail')}
                onReportLegalIssue={() => setReportTarget(responseDetails(message))}
                onViewDetails={() => setDetailTarget(responseDetails(message))}
                onError={setAnnouncement}
              />}
              {(message.status === 'stopped' || message.status === 'error') && index === lastAssistantIndex && <button type="button" className="pg-retry-response" disabled={streaming || unavailable || bootLoading} onClick={() => void sendPrompt(messages[index - 1]?.content || '', index - 1)}><RefreshCw size={16} aria-hidden="true"/>다시 시도</button>}
            </div>
          </div>)}
        </section>}
      </div>
      <div className="pg-compose-area">
        {!empty && <aside className="pg-signin-reminder"><p>대화를 저장하고 더 많은 기능을<br className="pg-reminder-break"/> 사용하려면 로그인하세요.</p>{signIn('pg-reminder-signin')}</aside>}
        {(bootError || (bootstrap?.available && bootstrap.remaining <= 0)) && <div className="pg-service-notice" role="status"><span>{bootError || '오늘의 체험 횟수를 모두 사용했습니다.'}</span>{bootError ? <button type="button" disabled={bootLoading} onClick={() => void loadBootstrap()}>{bootLoading ? '연결 중…' : '다시 연결'}</button> : signIn('', '로그인')}</div>}
        {editing !== null && <div className="pg-edit-notice"><span>질문 수정 · 전송하면 이후 대화가 새로 생성됩니다.</span><button type="button" onClick={() => { setEditing(null); setDraft(''); }} aria-label="수정 취소"><X size={16}/></button></div>}
        {composerError && <div className="pg-composer-error" role="alert">{composerError}</div>}
        <form className={`pg-composer ${listening ? 'pg-is-listening' : ''}`} onSubmit={event => { event.preventDefault(); submit(); }}>
          <div className="pg-tools-anchor"><button type="button" className="pg-icon-button pg-add-button" data-popup-trigger aria-label="도구 및 파일" aria-haspopup="menu" aria-expanded={popup === 'tools'} onClick={event => togglePopup('tools', event.currentTarget)}><Plus size={24}/></button>{popup === 'tools' && <div className="pg-popover pg-tools-menu" role="menu" aria-label="도구 및 파일"><div className="pg-menu-heading">로그인하여 사용</div><a href={signInHref} target="_top" role="menuitem" onClick={rememberSignIn}><FilePlus2 size={18}/><span>파일 추가</span><LockKeyhole size={14}/></a><div className="pg-menu-divider"/><a href={signInHref} target="_top" role="menuitem" onClick={rememberSignIn}><ImagePlus size={18}/><span>이미지 생성</span><LockKeyhole size={14}/></a><a href={signInHref} target="_top" role="menuitem" onClick={rememberSignIn}><SquarePen size={18}/><span>문서 작업</span><LockKeyhole size={14}/></a><a href={signInHref} target="_top" role="menuitem" onClick={rememberSignIn}><Sparkles size={18}/><span>워크스페이스 도구</span><LockKeyhole size={14}/></a>{signIn('pg-menu-signin', '로그인하여 계속하기', true)}</div>}</div>
          <label className="pg-sr-only" htmlFor="pg-prompt">Prism에 메시지 보내기</label><textarea id="pg-prompt" ref={inputRef} value={draft} onChange={event => { setDraft(event.target.value); if (composerError) setComposerError(''); }} onKeyDown={composerKey} placeholder="Prism에게 물어보세요" rows={1} maxLength={8000} disabled={!ready} aria-describedby="pg-input-help"/>
          <div className="pg-desktop-model-anchor">{modelPicker(false)}</div>
          {streaming ? <button type="button" className="pg-submit pg-stop" aria-label="답변 생성 중지" title="답변 생성 중지" onClick={stop}><Square size={17} fill="currentColor"/></button> : draft.trim() ? <button type="submit" className="pg-submit" disabled={!canSubmit} aria-label="메시지 보내기" title="메시지 보내기">{bootLoading ? <LoaderCircle size={20} className="pg-spin"/> : <ArrowUp size={22}/>}</button> : <button type="button" className="pg-icon-button pg-mic" aria-label={listening ? '음성 입력 중지' : '음성 입력'} aria-pressed={listening} title="음성 입력" disabled={!ready} onClick={dictate}><Mic size={22}/></button>}
        </form>
        <p id="pg-input-help" className="pg-sr-only">Enter로 전송하고 Shift와 Enter로 줄을 바꿀 수 있습니다. 체험 대화는 이 탭에 임시로 보관됩니다.</p>
      </div>
      <footer className="pg-footer"><p className="pg-accuracy">OpenPrism은 실수할 수 있습니다. 중요한 정보는 확인해 주세요.</p><span className="pg-footer-legal"><a href="/privacy">개인정보 처리방침</a><span aria-hidden="true"> · </span><a href="/terms">이용약관</a></span></footer>
    </div>
    {modal === 'sign-in' && <GuestSignInDialog reason={signInReason} signInHref={signInHref} onSignIn={rememberSignIn} onClose={() => setModal(null)} returnFocus={dialogTrigger.current}/>}
    {(modal === 'new-chat' || modal === 'delete-chat') && <GuestDialog returnFocus={dialogTrigger.current} title={modal === 'delete-chat' ? '대화를 삭제할까요?' : '새 채팅을 시작할까요?'} onClose={() => setModal(null)} className="pg-new-chat-dialog"><p>{modal === 'delete-chat' ? '이 탭의 대화와 의견을 삭제합니다. 삭제한 대화는 복구할 수 없습니다.' : <>현재 대화는 이 탭에 임시 보관되어 있습니다.<br/>새 채팅을 시작하면 이 대화가 삭제됩니다.</>}</p><div className="pg-dialog-actions"><button type="button" data-initial-focus className="pg-dialog-cancel" onClick={() => setModal(null)}>취소</button><button type="button" className="pg-dialog-primary" onClick={clearChat}>{modal === 'delete-chat' ? '삭제' : '새 채팅'}</button></div></GuestDialog>}
    {modal === 'rename-chat' && <GuestDialog returnFocus={dialogTrigger.current} title="이름 변경" onClose={() => setModal(null)}>
      <form onSubmit={renameChat}><label className="pg-rename-field">대화 이름<input data-initial-focus value={renameDraft} onChange={event => { setRenameDraft(event.target.value); setRenameError(''); }} onFocus={event => event.currentTarget.select()} maxLength={120} required/></label>{renameError && <p className="pg-answer-error" role="alert">{renameError}</p>}<div className="pg-dialog-actions"><button type="button" className="pg-dialog-cancel" onClick={() => setModal(null)}>취소</button><button type="submit" className="pg-dialog-primary" disabled={!renameDraft.trim()}>저장</button></div></form>
    </GuestDialog>}
    {modal === 'pin-chat' && <GuestDialog returnFocus={dialogTrigger.current} title="대화를 고정하려면 로그인하세요" onClose={() => setModal(null)}><p>로그인한 뒤 현재 대화를 저장하면 채팅 기록에서 고정할 수 있습니다.</p><div className="pg-dialog-actions"><button type="button" data-initial-focus className="pg-dialog-cancel" onClick={() => setModal(null)}>취소</button>{signIn('pg-dialog-signin')}</div></GuestDialog>}
    {modal === 'install' && <GuestDialog returnFocus={dialogTrigger.current} title="OpenPrism 앱 설치" onClose={() => setModal(null)}><p>OpenPrism을 홈 화면이나 데스크톱에 추가하면 앱처럼 바로 열 수 있습니다.</p>{installEvent ? <button className="pg-install-action" type="button" onClick={() => void install()}><Download size={18}/>이 기기에 설치</button> : <div className="pg-install-instructions"><p><strong>Chrome · Edge</strong><br/>브라우저 메뉴에서 ‘설치’ 또는 ‘앱으로 설치’를 선택해 주세요.</p><p><strong>iPhone · iPad</strong><br/>Safari의 공유 메뉴에서 ‘홈 화면에 추가’를 선택해 주세요.</p><p>설치 메뉴가 없으면 이 페이지를 북마크해 이용할 수 있습니다.</p></div>}{installMessage && <p role="status">{installMessage}</p>}<div className="pg-dialog-actions"><button type="button" data-initial-focus className="pg-dialog-primary" onClick={() => setModal(null)}>닫기</button></div></GuestDialog>}
    {exportTarget && <DeferredPanel dialog label="내보내기" onClose={() => setExportTarget(null)}><ExportDialog target={exportTarget} signedIn={false} onClose={() => setExportTarget(null)}/></DeferredPanel>}
    {detailTarget && <DeferredPanel dialog label="대답 세부정보" onClose={() => setDetailTarget(null)}><ResponseDetailsDialog target={detailTarget} onClose={() => setDetailTarget(null)}/></DeferredPanel>}
    {reportTarget && <DeferredPanel dialog label="법적 문제 신고" onClose={() => setReportTarget(null)}><LegalReportDialog target={reportTarget} signedIn={false} onClose={() => setReportTarget(null)}/></DeferredPanel>}
    <div key={copyNotice ? copyNoticeKey : 'announcement'} className="pg-sr-only" role="status" aria-live="polite" aria-atomic="true">{copyNotice || announcement}</div>
    {toastNotice && <div className="pg-toast" aria-hidden="true">{toastNotice}</div>}
  </div>;
}
