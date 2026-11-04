'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowUp, ArrowUpRight, ArrowRight, Plus, Search, MessageSquare, Columns2, Grid2X2, Clock3, FolderOpen, ChartNoAxesCombined, Settings2, ChevronDown, ChevronRight, Check, X, Paperclip, SlidersHorizontal, Sparkles, Code2, PenLine, Lightbulb, Brain, Copy, Download, Trash2, ExternalLink, ShieldCheck, LoaderCircle, Menu, BookOpen, Command, LogOut, PlugZap, FileText, AlertCircle, Square, Link2, CheckCircle2, RefreshCw, Wallet, MoreHorizontal } from 'lucide-react';
import { MODELS, PROVIDERS, Provider, Model, findModel } from '../lib/models';
import BillingPanel from './billing-panel';
import { Image, Video, Hexagon, PanelLeftClose, PanelLeftOpen, History, NotebookPen, Share2 } from 'lucide-react';
import { Composer } from '../components/workspace/composer';
import { PrismMark, WorkspaceHeader, NotebookDialog } from '../components/workspace/chrome';
import { SettingsMenu } from '../components/workspace/settings-menu';
import { SettingsPages } from '../components/workspace/settings-pages';
import { ChatSearchDialog } from '../components/workspace/chat-search';
type Chat = {
    id: string;
    title: string;
    model: string;
    updated_at: number;
};
type Message = {
    id: string;
    role: string;
    content: string;
    model?: string;
};
type FileRecord = {
    id: string;
    name: string;
    size: number;
    created_at: number;
};
type Bootstrap = {
    beta?: boolean;
    models?: Model[];
    user: {
        name: string;
        email: string;
    } | null;
    providers: Record<Provider, {
        configured: boolean;
    }>;
    isAdmin: boolean;
};
type CompareResult = {
    text: string;
    loading: boolean;
    error?: string;
    conversationId?: string;
    usage?: {
        input: number;
        output: number;
    };
};
const blankProviders = { openai: { configured: false }, anthropic: { configured: false }, google: { configured: false } };
const nav = [{ path: '/chat', label: 'New chat', icon: MessageSquare }, { path: '/compare', label: 'Compare models', icon: Columns2 }, { path: '/models', label: 'Model library', icon: Grid2X2 }];
const worknav = [{ path: '/history', label: 'Chat history', icon: Clock3 }, { path: '/files', label: 'My files', icon: FolderOpen }, { path: '/usage', label: 'Usage', icon: ChartNoAxesCombined }, { path: '/billing', label: '충전 및 잔액', icon: Wallet }];
function Mark({ provider, size = 'normal' }: {
    provider: Provider | 'prism';
    size?: string;
}) { return <span className={'model-mark ' + provider + ' ' + size}>{provider === 'openai' ? <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">{[0, 60, 120].map(a => <rect key={a} x="10" y="3" width="12" height="26" rx="6" stroke="currentColor" strokeWidth="1.8" transform={'rotate(' + a + ' 16 16)'}/>)}</svg> : provider === 'anthropic' ? <svg viewBox="0 0 32 32" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <path key={i} d="M16 3v9" transform={'rotate(' + i * 30 + ' 16 16)'} stroke="currentColor" strokeWidth="2.2"/>)}<circle cx="16" cy="16" r="4" fill="currentColor"/></svg> : provider === 'google' ? <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 1C17.5 10.5 21.5 14.5 31 16 21.5 17.5 17.5 21.5 16 31 14.5 21.5 10.5 17.5 1 16 10.5 14.5 14.5 10.5 16 1Z" fill="currentColor"/></svg> : <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 3 30 27H2Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="m16 3 2 16 12 8M2 27l16-8" stroke="currentColor" strokeWidth="1.3"/></svg>}</span>; }
async function api(path: string, options?: RequestInit): Promise<any> { const r = await fetch('/api/' + path, options); let d: any; try {
    d = await r.json();
}
catch {
    throw new Error('The server could not return a response. Please retry.');
} if (!r.ok)
    throw new Error(d.error || 'Request failed.'); return d; }
const post = (data: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const number = (n: number) => new Intl.NumberFormat('en-US').format(n || 0);
function TextResponse({ text }: {
    text: string;
}) { return <div className="response-text">{text.split(/(```[\s\S]*?```)/g).map((part, i) => part.startsWith('```') ? <pre key={i}><code>{part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}</code></pre> : <span key={i}>{part}</span>)}</div>; }
export default function Workspace() {
    const pathname = usePathname() || '/', router = useRouter();
    const rawView = pathname.split('/')[1] || 'chat', view = ({ library: 'history', pricing: 'billing', login: 'auth', signup: 'auth', 'forgot-password': 'auth', docs: 'faq' } as Record<string, string>)[rawView] || rawView, chatId = view === 'chat' ? pathname.split('/')[2] : undefined;
    const [boot, setBoot] = useState<Bootstrap>({ user: null, providers: blankProviders, isAdmin: false }), [ready, setReady] = useState(false), [chats, setChats] = useState<Chat[]>([]), [files, setFiles] = useState<FileRecord[]>([]);
    const [modelId, setModelId] = useState('gpt-6.1-sol'), [effort, setEffort] = useState('medium'), [pro, setPro] = useState(false), [modelOpen, setModelOpen] = useState(false), [modelQuery, setModelQuery] = useState('');
    const [prompt, setPrompt] = useState(''), [messages, setMessages] = useState<Message[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [mobile, setMobile] = useState(false), [help, setHelp] = useState(false), [filter, setFilter] = useState('all'), [search, setSearch] = useState(''), [purpose, setPurpose] = useState('all'), [attached, setAttached] = useState<string[]>([]), [fileOpen, setFileOpen] = useState(false), [uploading, setUploading] = useState(false), [usage, setUsage] = useState<any>(null), [admin, setAdmin] = useState<any>(null), [deleteTarget, setDeleteTarget] = useState<{
        kind: string;
        id: string;
        title: string;
    } | null>(null), [rename, setRename] = useState<{
        id: string;
        title: string;
    } | null>(null);
    const [compared, setCompared] = useState(['gpt-6-astra', 'claude-fable-5-1']), [results, setResults] = useState<Record<string, CompareResult>>({});
    const [workspaceMode, setWorkspaceMode] = useState<'chat' | 'work'>('chat');
    const [searchOpen, setSearchOpen] = useState(false);
    const [collapsed, setCollapsed] = useState(false);
    const [notebookOpen, setNotebookOpen] = useState(false);
    const [selectedSkill, setSelectedSkill] = useState<{id:string;name:string} | null>(null);
    const [shareOpen, setShareOpen] = useState(false);
    const [shareBusy, setShareBusy] = useState(false);
    const [shareUrl, setShareUrl] = useState('');
    const [shareError, setShareError] = useState('');
    const mainRef = useRef<HTMLElement>(null);
    const sidebarRef = useRef<HTMLElement>(null);
    const followBottom = useRef(true);
    const abortRef = useRef<AbortController | null>(null), endRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLTextAreaElement>(null), uploadRef = useRef<HTMLInputElement>(null), runningId = useRef<string | undefined>(undefined);
    useEffect(() => () => abortRef.current?.abort(), []);
    const availableModels = boot.models ?? (boot.beta ? MODELS.filter(m => m.id === 'gpt-6.1-sol') : MODELS);
    const selected = findModel(modelId) || MODELS[3], connected = Object.values(boot.providers).filter(p => p.configured).length;
    const loadChats = useCallback(async () => { try {
        setChats(await api('conversations'));
    }
    catch { } }, []);
    const loadFiles = useCallback(async () => { try {
        setFiles(await api('files'));
    }
    catch { } }, []);
    useEffect(() => { api('bootstrap').then(d => { setBoot(d); if (d.user) {
        loadChats();
        loadFiles();
    } }).catch(e => setError(e.message)).finally(() => setReady(true)); }, [loadChats, loadFiles]);
    useEffect(() => {
        setMobile(false);
        setError('');
        setSearch('');
        setModelOpen(false);
        if (view === 'models' && ['openai', 'anthropic', 'google'].includes(pathname.split('/')[2] || ''))
            setFilter(pathname.split('/')[2]);
        if (view === 'chat') {
            if (chatId && chatId !== runningId.current) {
                setMessages([]);
                api('conversations/' + chatId).then(d => { setMessages(d.messages); setModelId(d.conversation.model); }).catch(e => setError(e.message));
            }
            else if (!chatId && !busy) {
                setMessages([]);
                setPrompt('');
                runningId.current = undefined;
            }
        }
        if (view === 'usage')
            api('usage').then(setUsage).catch(e => setError(e.message));
        if (view === 'files')
            loadFiles();
        if (view === 'history')
            loadChats();
        if (view === 'admin')
            api('admin').then(setAdmin).catch(e => setError(e.message));
    }, [pathname]);
    useEffect(() => { if (!selected.efforts.includes(effort))
        setEffort(selected.efforts.includes('medium') ? 'medium' : selected.efforts[0] || 'medium'); if (!selected.pro)
        setPro(false); }, [modelId]);
    useEffect(() => { if (view === 'compare' && !['low','medium','high'].includes(effort)) setEffort('medium'); }, [view,effort]);
    useEffect(() => { if (messages.length && followBottom.current) endRef.current?.scrollIntoView({ behavior: 'instant' }); }, [messages]);
    useEffect(() => { if (notice) {
        const t = setTimeout(() => setNotice(''), 3500);
        return () => clearTimeout(t);
    } }, [notice]);
    useEffect(() => { const media = window.matchMedia('(max-width: 767px)'); const resize = () => { if (!media.matches) setMobile(false); }; media.addEventListener('change',resize); return () => media.removeEventListener('change',resize); }, []);
    useEffect(() => {
        if (!mobile) return;
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const sidebar = sidebarRef.current;
        const workspace = mainRef.current?.parentElement;
        workspace?.setAttribute('inert', '');
        sidebar?.querySelector<HTMLButtonElement>('button')?.focus();
        const trap = (event: KeyboardEvent) => {
            if (event.key !== 'Tab' || event.defaultPrevented || document.querySelector('[role="menu"][data-state="open"],[role="dialog"][data-state="open"]')) return;
            const items = sidebar?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),[tabindex="0"]');
            if (!items?.length) return;
            const first = items[0], last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', trap);
        return () => { workspace?.removeAttribute('inert'); document.removeEventListener('keydown', trap); previous?.focus(); };
    }, [mobile]);
    useEffect(() => { const fn = (e: KeyboardEvent) => { if (e.defaultPrevented) return; if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
    } if (e.key === 'Escape') {
        setHelp(false);
        setSearchOpen(false);
        setModelOpen(false);
        setMobile(false);
        setDeleteTarget(null);
        setRename(null);
    } }; window.addEventListener('keydown', fn); return () => window.removeEventListener('keydown', fn); }, [router]);
    const go = (path: string) => { if (busy && path !== pathname) {
        setNotice('Stop the current response before switching pages.');
        return;
    } setMobile(false); router.push(path); };
    function choose(m: Model) { setModelId(m.id); setModelOpen(false); setModelQuery(''); }
    function example(value: string) { setPrompt(value); inputRef.current?.focus(); }
    async function stream(model: string, conversationId: string | undefined, signal: AbortSignal, onEvent: (data: any) => void) {
        const r = await fetch('/api/chat', { ...post({ model, prompt, effort: findModel(model)?.efforts.includes(effort) ? effort : 'medium', pro: findModel(model)?.pro ? pro : false, conversationId, fileIds: attached, workspaceMode, skillId:selectedSkill?.id }), signal });
        if (!r.ok) {
            const d: any = await r.json();
            throw new Error(d.error || 'Unable to connect.');
        }
        if (!r.body)
            throw new Error('Empty response.');
        const reader = r.body.getReader(), decoder = new TextDecoder();
        let buffer = '', doneEvent = false;
        try {
            while (true) {
                const { done, value } = await reader.read();
                buffer += decoder.decode(value, { stream: !done });
                let i;
                while ((i = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, i);
                    buffer = buffer.slice(i + 1);
                    if (line.startsWith('data: ')) {
                        const event = JSON.parse(line.slice(6));
                        if (event.type === 'error')
                            throw new Error(event.error);
                        if (event.type === 'done')
                            doneEvent = true;
                        onEvent(event);
                    }
                }
                if (done)
                    break;
            }
            if (!doneEvent)
                throw new Error('The response ended before it completed.');
        }
        finally {
            reader.releaseLock();
        }
    }
    async function send() {
        if (!prompt.trim() || busy || !ready || uploading)
            return;
        setError('');
        followBottom.current = true;
        if (!boot.user) {
            setError('Sign in to send messages and save your conversations.');
            return;
        }
        const targets = view === 'compare' ? compared : [modelId];
        if (targets.some(id => !boot.providers[findModel(id)!.provider].configured)) {
            setError('Connect ' + [...new Set(targets.filter(id => !boot.providers[findModel(id)!.provider].configured).map(id => PROVIDERS[findModel(id)!.provider].name))].join(' and ') + ' in Settings to start a real AI response.');
            return;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        if (view === 'compare') {
            setResults(Object.fromEntries(targets.map(id => [id, { text: '', loading: true }])));
            await Promise.allSettled(targets.map(async (id) => { try {
                await stream(id, undefined, controller.signal, e => setResults(old => ({ ...old, [id]: { ...old[id], ...(e.type === 'delta' ? { text: old[id].text + e.text } : e.type === 'start' ? { conversationId: e.conversationId } : e.type === 'done' ? { loading: false, usage: e.usage } : {}) } })));
            }
            catch (e) {
                setResults(old => ({ ...old, [id]: { ...old[id], loading: false, error: e instanceof Error && e.name === 'AbortError' ? 'Response stopped.' : e instanceof Error ? e.message : 'Request failed.' } }));
            } }));
        }
        else {
            const userId = crypto.randomUUID(), assistantId = crypto.randomUUID();
            let started = false;
            setMessages(old => [...old, { id: userId, role: 'user', content: prompt }, { id: assistantId, role: 'assistant', content: '', model: modelId }]);
            try {
                await stream(modelId, chatId, controller.signal, e => {
                    if (e.type === 'start') {
                        started = true;
                        runningId.current = e.conversationId;
                    }
                    if (e.type === 'delta')
                        setMessages(old => old.map(m => m.id === assistantId ? { ...m, content: m.content + e.text } : m));
                    if (e.type === 'done') {
                        setPrompt('');
                        setAttached([]);
                        if (!chatId)
                            router.replace('/chat/' + e.conversationId);
                    }
                });
            }
            catch (e) {
                setError(e instanceof Error && e.name === 'AbortError' ? 'Response stopped. The provider may still charge for generated tokens.' : e instanceof Error ? e.message : 'Request failed.');
                if (!started)
                    setMessages(old => old.filter(m => m.id !== userId && m.id !== assistantId));
                else
                    setMessages(old => old.filter(m => m.id !== assistantId));
            }
        }
        setBusy(false);
        abortRef.current = null;
        loadChats();
    }
    async function upload(file: File) { setUploading(true); setError(''); try {
        const f = new FormData();
        f.append('file', file);
        const created = await api('files', { method: 'POST', body: f });
        await loadFiles();
        setNotice('File uploaded. It is ready to attach to a chat.');
        if (view === 'chat')
            setAttached(a => [...a, created.id].slice(-3));
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setUploading(false);
        if (uploadRef.current)
            uploadRef.current.value = '';
    } }
    async function remove() { if (!deleteTarget)
        return; try {
        await api(deleteTarget.kind + '/' + deleteTarget.id, { method: 'DELETE' });
        if (deleteTarget.kind === 'files') {
            setAttached(a => a.filter(x => x !== deleteTarget.id));
            await loadFiles();
        }
        else {
            await loadChats();
            if (chatId === deleteTarget.id)
                go('/chat');
        }
        setDeleteTarget(null);
        setNotice('Deleted successfully.');
    }
    catch (e) {
        setError((e as Error).message);
    } }
    async function copy(text: string) { try {
        await navigator.clipboard.writeText(text);
        setNotice('Copied to clipboard.');
    }
    catch {
        setError('Clipboard access is unavailable in this browser.');
    } }
    function exportChat() { const blob = new Blob([messages.map(m => (m.role === 'user' ? 'You' : findModel(m.model || '')?.name || 'AI') + '\n\n' + m.content).join('\n\n────────────\n\n')], { type: 'text/plain' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'prism-conversation.txt'; a.click(); URL.revokeObjectURL(url); }
    const sectionTitle: Record<string, string> = { chat: 'New chat', compare: 'Compare models', models: 'Model library', history: 'Chat history', files: 'My files', usage: 'Usage', settings: 'Settings', billing: '충전 및 잔액', admin: 'Administration', privacy: 'Privacy', terms: 'Terms', faq: 'Help & FAQ' };
    function providerStatus(p: Provider) { return <span className={'connection ' + (boot.providers[p].configured ? 'online' : '')}><i />{boot.providers[p].configured ? 'Configured' : 'Not connected'}</span>; }
    function modelCard(m: Model, index: number) { return <button key={m.id} className={'model-card provider-' + m.provider + (selected.id === m.id ? ' chosen' : '')} onClick={() => { choose(m); go('/chat'); }}><div className="card-top"><Mark provider={m.provider}/><span className={'tier ' + (m.tier === 'Advanced' ? 'premium' : '')}>{index === 0 && view === 'chat' ? <Sparkles size={11}/> : null}{m.tier}</span></div><h3>{m.name}</h3><p>{m.description}</p><div className="card-foot"><span>{m.category}</span><ArrowUpRight size={16}/></div></button>; }
    const errorBanner = error && <div className="error-banner" role="alert"><AlertCircle size={17}/><span>{error}</span>{error.includes('Connect') || error.includes('not connected') ? <button onClick={() => go('/settings')}>Open settings <ArrowRight size={13}/></button> : !boot.user ? <a href="/signin-with-chatgpt?return_to=%2Fchat" target="_top">Sign in</a> : null}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={15}/></button></div>;
    const composer = <Composer
      prompt={prompt} onPrompt={setPrompt} inputRef={inputRef}
      models={availableModels} selected={selected} onModel={choose} providers={boot.providers}
      effort={effort} onEffort={setEffort} mode={workspaceMode} compare={view === 'compare'}
      busy={busy} ready={ready} uploading={uploading} files={files} attached={attached}
      signedIn={!!boot.user} selectedSkill={selectedSkill} onSkill={setSelectedSkill}
      onAttach={id => setAttached(current => current.includes(id) ? current : [...current, id].slice(-3))}
      onDetach={id => setAttached(current => current.filter(value => value !== id))}
      onUpload={() => uploadRef.current?.click()} onSend={send}
      onStop={() => abortRef.current?.abort()} onNavigate={go} onError={setError}/>;
    function newChat() {
      if (busy) { setNotice('응답을 중지한 뒤 새 채팅을 시작해주세요.'); return; }
      setMobile(false);
      setMessages([]); setPrompt(''); setAttached([]); setSelectedSkill(null); runningId.current = undefined;
      if (pathname !== '/chat' && pathname !== '/') go('/chat');
      inputRef.current?.focus();
    }
    async function createNotebook(file: File) {
      if (!boot.user) throw new Error('노트북을 저장하려면 로그인해주세요.');
      const body = new FormData(); body.append('file', file);
      const created = await api('files', {method: 'POST', body});
      await loadFiles(); setAttached([created.id]); setNotice('노트북을 저장하고 채팅에 첨부했습니다.');
      go('/chat');
    }
    async function createShare() {
      if (!chatId || shareBusy) return;
      setShareBusy(true); setShareError('');
      try { const result = await api('shares', post({conversationId:chatId})); setShareUrl(new URL('/share/' + encodeURIComponent(result.token), window.location.origin).href); }
      catch (failure) { setShareError(failure instanceof Error ? failure.message : '공개 링크를 만들지 못했습니다.'); }
      finally { setShareBusy(false); }
    }
    const secondaryView = ['personalization-settings', 'gemini-spark', 'browser-settings', 'customize', 'gems', 'import', 'sharing', 'share', 'images', 'videos', 'scheduled', 'feedback'].includes(view);
    return <div className={'app-shell gemini-shell ' + (mobile ? 'sidebar-open ' : '') + (collapsed ? 'sidebar-collapsed' : '')}>
 <input ref={uploadRef} type="file" accept=".txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.html,.css,.xml,.yaml,.yml,.sql" hidden onChange={e => { const f = e.target.files?.[0]; if (f)
        upload(f); }}/>
 {mobile && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMobile(false)}/>}
 <aside ref={sidebarRef} className="sidebar gemini-sidebar" aria-label="주 탐색" role={mobile ? 'dialog' : undefined} aria-modal={mobile ? true : undefined}>
   <div className="gemini-brand-row"><a href="/chat" className="gemini-brand" aria-label="Prism 홈" onClick={event => { event.preventDefault(); newChat(); }}><PrismMark/><span>Prism</span></a><div className="sidebar-tools"><button type="button" aria-label="채팅 검색" onClick={() => setSearchOpen(true)}><Search size={18}/></button><button type="button" aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'} onClick={() => { if (window.matchMedia('(max-width: 767px)').matches) setMobile(false); else setCollapsed(value => !value); }}>{collapsed ? <PanelLeftOpen size={17}/> : <PanelLeftClose size={17}/>}</button></div></div>
   <nav className="gemini-navigation">
     <button className="gemini-nav-item gemini-new-chat" onClick={newChat} title="새 채팅"><PenLine size={19}/><span>새 채팅</span></button>
     {[{path:'/library',label:'라이브러리',icon:Grid2X2},{path:'/images',label:'이미지',icon:Image},{path:'/scheduled',label:'예약됨',icon:Clock3},{path:'/customize/skills',label:'맞춤설정',icon:Hexagon},{path:'/videos',label:'동영상',icon:Video}].map(item => <button key={item.path} className={'gemini-nav-item ' + (pathname === item.path ? 'is-active' : '')} onClick={() => go(item.path)} title={item.label}><item.icon size={19}/><span>{item.label}</span></button>)}
   </nav>
   <section className="gemini-notebooks"><h2>노트북</h2><button className="gemini-nav-item" onClick={() => setNotebookOpen(true)} title="새 노트북"><Plus size={21}/><span>새 노트북</span></button>{files.filter(file => file.name.endsWith('.md')).slice(0,3).map(file => <button key={file.id} className="gemini-nav-item gemini-notebook-item" onClick={() => { setAttached([file.id]); go('/chat'); setNotice('노트북을 첨부했습니다.'); }} title={file.name}><NotebookPen size={17}/><span>{file.name.replace(/\.md$/, '')}</span></button>)}</section>
   <button className="gemini-activity" onClick={() => go(boot.user ? '/history' : '/settings')}><History size={21}/><span>{boot.user ? 'Prism 채팅 기록이 저장됩니다' : 'Prism에 로그인하고 시작하세요'}<u>{boot.user ? '활동 및 대화 관리' : '여기에서 로그인'}</u></span></button>
   {chats.length > 0 && <section className="gemini-recent"><h2>최근</h2>{chats.slice(0,8).map(chat => <button key={chat.id} className={chatId === chat.id ? 'is-active' : ''} onClick={() => go('/chat/' + chat.id)} title={chat.title}>{chat.title}</button>)}</section>}
   <div className="gemini-account-row"><button className="gemini-account" onClick={() => go('/settings')}><span className="gemini-avatar">{boot.user?.name?.[0]?.toUpperCase() || 'P'}</span><span><strong>{boot.user?.name || 'Prism'}</strong><small>{boot.user ? boot.beta ? '무료 베타' : '개인 계정' : '로그인'}</small></span></button><SettingsMenu onNavigate={go} onHelp={() => setHelp(true)} signedIn={!!boot.user} beta={boot.beta} triggerClassName="gemini-settings-trigger"/></div>
 </aside>
 <div className="main-shell gemini-workspace"><WorkspaceHeader onMenu={() => { if (window.matchMedia('(max-width: 767px)').matches) setMobile(true); else setCollapsed(false); }} onNew={newChat} onNotice={setNotice} showNavigation={collapsed}/>
 <main ref={mainRef} className={'main-content gemini-main view-' + view} onScroll={event => { const target = event.currentTarget; followBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 120; }}>{errorBanner}
 {['history','files','models','compare'].includes(view) && <nav className="prism-library-nav" aria-label="라이브러리 종류">{[{path:'/history',label:'채팅'},{path:'/files',label:'파일 및 노트북'},{path:'/models',label:'AI 모델'},...(!boot.beta?[{path:'/compare',label:'모델 비교'}]:[])].map(item => <button key={item.path} onClick={() => go(item.path)} aria-current={view === item.path.slice(1) ? 'page' : undefined}>{item.label}</button>)}</nav>}
 {view === 'chat' && (messages.length === 0 ? <div className="gemini-welcome"><div className="gemini-welcome-inner"><h1>{workspaceMode === 'chat' ? '무엇을 도와드릴까요?' : '어떤 작업을 도와드릴까요?'}</h1>{composer}<div className="gemini-mode-switch" role="group" aria-label="작업 모드"><button type="button" aria-pressed={workspaceMode === 'chat'} className={workspaceMode === 'chat' ? 'selected' : ''} onClick={() => setWorkspaceMode('chat')}>채팅</button><button type="button" aria-pressed={workspaceMode === 'work'} className={workspaceMode === 'work' ? 'selected' : ''} onClick={() => setWorkspaceMode('work')}>작업</button></div></div></div> : <div className="conversation-screen"><div className="chat-toolbar"><span><MessageSquare size={15}/> {chats.find(c => c.id === chatId)?.title || 'Your conversation'}</span><div className="prism-chat-actions">{chatId && <button disabled={busy} onClick={() => { setShareOpen(true); setShareUrl(''); setShareError(''); }}><Share2 size={15}/>공유</button>}<button onClick={exportChat}><Download size={14}/>내보내기</button></div></div><div className="messages">{messages.map(m => <div key={m.id} className={'message ' + m.role}>{m.role === 'assistant' ? <Mark provider={findModel(m.model || '')?.provider || selected.provider} size="small"/> : <span className="avatar">{boot.user?.name?.[0] || 'Y'}</span>}<div className="message-body"><h4>{m.role === 'user' ? 'You' : findModel(m.model || '')?.name || selected.name}</h4>{m.content ? <TextResponse text={m.content}/> : <div className="thinking"><LoaderCircle size={15} className="spin"/> Thinking it through…</div>}{m.content && <button className="message-copy" onClick={() => copy(m.content)}><Copy size={13}/> Copy</button>}</div></div>)}<div ref={endRef}/></div><div className="chat-composer">{composer}</div></div>)}
 {view === 'compare' && !boot.beta && <div className="page-inner"><div className="page-heading"><span className="eyebrow">MORE PERSPECTIVES. BETTER DECISIONS.</span><h1>One question. Different minds.</h1><p>Send the same prompt to your models and compare real responses side by side.</p></div><div className="compare-selectors">{compared.map((id, i) => <div key={i} className="compare-select"><Mark provider={findModel(id)!.provider} size="small"/><select aria-label={'Comparison model ' + (i + 1)} disabled={busy} value={id} onChange={e => { if (compared.includes(e.target.value)) {
        setNotice('Choose a different model for each panel.');
        return;
    } setCompared(x => x.map((v, n) => n === i ? e.target.value : v)); setResults({}); }}>{availableModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>{compared.length > 2 && <button aria-label="Remove comparison panel" className="icon-button" onClick={() => setCompared(x => x.filter((_, n) => n !== i))}><X size={14}/></button>}</div>)}{compared.length < 3 && <button className="add-model" disabled={busy} onClick={() => { setCompared(x => [...x, MODELS.find(m => !x.includes(m.id))!.id]); setResults({}); }}><Plus size={15}/>Add model</button>}</div><div className="compare-grid" style={{ gridTemplateColumns: 'repeat(' + compared.length + ', minmax(0,1fr))' }}>{compared.map(id => <article key={id} className="compare-panel"><div className="compare-panel-head"><strong>{findModel(id)!.name}</strong>{providerStatus(findModel(id)!.provider)}</div>{results[id]?.text ? <div className="comparison-answer"><TextResponse text={results[id].text}/><button className="text-button" onClick={() => copy(results[id].text)}><Copy size={13}/>Copy response</button></div> : <div className="compare-empty"><Mark provider={findModel(id)!.provider}/><h3>A different perspective</h3><p>{findModel(id)!.category}<br />The response will appear here.</p></div>}{results[id]?.loading && <p className="panel-state"><LoaderCircle className="spin" size={14}/>Working on your prompt…</p>}{results[id]?.error && <p className="panel-error" role="alert">{results[id].error}</p>}{results[id]?.usage && <div className="panel-state"><CheckCircle2 size={13}/>{number(results[id].usage!.input + results[id].usage!.output)} tokens <button onClick={() => go('/chat/' + results[id].conversationId)}>Open chat <ArrowUpRight size={12}/></button></div>}</article>)}</div>{composer}<p className="fine-print">Each comparison sends a separate API request to each selected provider and incurs its API usage charges.</p></div>}
 {view === 'compare' && boot.beta && <div className="page-inner"><h1>More models are coming</h1><p>The free beta starts with GPT-6.1 Sol. Multi-model comparison will become available when additional providers are connected.</p></div>}{view === 'models' && <div className="page-inner"><div className="page-heading"><span className="eyebrow">MEET YOUR NEXT THINKING PARTNER</span><h1>Many minds. One workspace.</h1><p>Explore models by what you want to do. Choose one and make it your own.</p></div><div className="filter-bar"><div className="filter-tabs">{['all', 'openai', 'anthropic', 'google'].map(p => <button className={filter === p ? 'selected' : ''} key={p} onClick={() => setFilter(p)}>{p === 'all' ? 'All models' : PROVIDERS[p as Provider].name}</button>)}</div><div className="search-input"><Search size={15}/><input aria-label="Search models" placeholder="Search models…" value={search} onChange={e => setSearch(e.target.value)}/></div></div><div className="model-grid library-grid">{availableModels.filter(m => (filter === 'all' || m.provider === filter) && (m.name + ' ' + m.category).toLowerCase().includes(search.toLowerCase())).map(modelCard)}</div>{availableModels.filter(m => (filter === 'all' || m.provider === filter) && (m.name + ' ' + m.category).toLowerCase().includes(search.toLowerCase())).length === 0 && <Empty icon={<Search />} title="No matching models" text="Try another name or provider."/>}<div className="info-panel"><ShieldCheck size={19}/><div><strong>Real API models, clearly labeled.</strong><p>Availability depends on your provider account. Pro and Extra High are reasoning settings on supported GPT models. Subscription-only modes such as Gemini Deep Think are not offered here without verified API access.</p><div className="source-links">{Object.entries(PROVIDERS).map(([p, v]) => <a key={p} href={MODELS.find(m => m.provider === p)!.source} target="_blank" rel="noreferrer">{v.name} model docs <ExternalLink size={12}/></a>)}</div></div></div></div>}
 {view === 'history' && <div className="page-inner"><div className="page-heading row-heading"><div><span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h1>Your conversations</h1><p>Good ideas are worth coming back to.</p></div><button className="primary-button" onClick={() => go('/chat')}><Plus size={15}/>New conversation</button></div><div className="search-input wide-search"><Search size={17}/><input autoFocus placeholder="Search your conversations…" aria-label="Search conversations" value={search} onChange={e => setSearch(e.target.value)}/><kbd>⌘ K</kbd></div>{chats.length === 0 ? <Empty icon={<MessageSquare />} title="A blank page, full of possibility." text="Start a conversation. Your chats will be saved here automatically." action={<button className="primary-button" onClick={() => go('/chat')}>Start a conversation <ArrowRight size={14}/></button>}/> : <div className="history-list">{chats.filter(c => c.title.toLowerCase().includes(search.toLowerCase())).map(c => <div className="history-row" key={c.id}><button className="history-chat" onClick={() => go('/chat/' + c.id)}><Mark provider={findModel(c.model)?.provider || 'openai'} size="small"/><span><strong>{c.title}</strong><small>{findModel(c.model)?.name || c.model} <span>·</span> {new Date(c.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</small></span></button><button className="icon-button" aria-label={'Rename ' + c.title} onClick={() => setRename({ id: c.id, title: c.title })}><PenLine size={15}/></button><button className="icon-button danger-hover" aria-label={'Delete ' + c.title} onClick={() => setDeleteTarget({ kind: 'conversations', id: c.id, title: c.title })}><Trash2 size={15}/></button></div>)}{!chats.some(c => c.title.toLowerCase().includes(search.toLowerCase())) && <Empty icon={<Search />} title="No conversations found" text="Try a different search."/>}</div>}</div>}
 {view === 'files' && <div className="page-inner"><div className="page-heading row-heading"><div><span className="eyebrow">GIVE YOUR IDEAS SOME CONTEXT</span><h1>A home for your documents.</h1><p>Upload text and code, then bring them into any conversation.</p></div><button disabled={uploading} className="primary-button" onClick={() => uploadRef.current?.click()}>{uploading ? <LoaderCircle className="spin" size={16}/> : <Plus size={16}/>}Upload file</button></div><button className="drop-zone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file)
        upload(file); }} onClick={() => uploadRef.current?.click()}><span><FolderOpen size={28}/></span><strong>{uploading ? 'Uploading your document…' : 'Drop a little context here'}</strong><p>Drag a file, or click to browse</p><small>TXT, Markdown, CSV, JSON, and source code · Up to 128 KB · 100 files</small></button><div className="section-heading"><h2>Your files <span className="count-label">{files.length}</span></h2></div>{files.length ? <div className="history-list">{files.map(f => <div key={f.id} className="history-row"><span className="file-icon"><FileText size={20}/></span><div className="file-details"><strong>{f.name}</strong><small>{(f.size / 1024).toFixed(1)} KB · {new Date(f.created_at).toLocaleDateString()}</small></div><button className="text-button" onClick={() => { setAttached([f.id]); go('/chat'); setNotice('Document attached. Ask a question about it.'); }}>Use in chat <ArrowUpRight size={13}/></button><a className="icon-button" aria-label={'Download ' + f.name} href={'/api/files/' + f.id} download={f.name}><Download size={15}/></a><button className="icon-button danger-hover" aria-label={'Delete ' + f.name} onClick={() => setDeleteTarget({ kind: 'files', id: f.id, title: f.name })}><Trash2 size={15}/></button></div>)}</div> : <p className="empty-line">No documents yet. Your first upload will appear here.</p>}<p className="fine-print">Attached document text is sent to the provider you select. PDF and image parsing are not enabled in this release.</p></div>}
 {view === 'usage' && <div className="page-inner"><div className="page-heading row-heading"><div><span className="eyebrow">EVERY TOKEN, ACCOUNTED FOR</span><h1>A clear view of your usage.</h1><p>Actual provider token counts from your completed requests.</p></div><button className="secondary-button" onClick={() => api('usage').then(setUsage).catch(e => setError(e.message))}><RefreshCw size={14}/>Refresh</button></div><div className="stats-grid">{[{ label: 'Total requests', value: usage?.totals?.requests || 0, icon: MessageSquare, caption: 'All-time API requests' }, { label: 'Input tokens', value: usage?.totals?.input_tokens || 0, icon: ArrowUpRight, caption: 'Reported by your providers' }, { label: 'Output tokens', value: usage?.totals?.output_tokens || 0, icon: Sparkles, caption: 'Includes provider-reported reasoning' }].map(s => <div key={s.label} className="stat-card"><div>{s.label}<s.icon size={17}/></div><strong>{number(s.value)}</strong><small>{s.caption}</small></div>)}</div><section className="data-panel"><div className="section-heading"><h2>Usage by provider</h2><span>All time</span></div>{usage?.byProvider?.length ? usage.byProvider.map((p: any) => { const total = usage.byProvider.reduce((n: number, p: any) => n + p.input_tokens + p.output_tokens, 0) || 1; return <div key={p.provider} className="provider-usage"><Mark provider={p.provider} size="small"/><span>{PROVIDERS[p.provider as Provider].name}</span><div><i style={{ width: ((p.input_tokens + p.output_tokens) / total * 100) + '%' }}/></div><strong>{number(p.input_tokens + p.output_tokens)} tokens</strong></div>; }) : <Empty icon={<ChartNoAxesCombined />} title="Your story starts with a question." text="Send your first message to see real usage here."/>}</section><section className="data-panel"><div className="section-heading"><h2>Recent requests</h2><span>Last 50</span></div><div className="table-scroll"><table><thead><tr><th>Model</th><th>Tokens in / out</th><th>Duration</th><th>Status</th><th>Date</th></tr></thead><tbody>{usage?.recent?.map((r: any) => <tr key={r.id}><td>{findModel(r.model)?.name || r.model}</td><td>{number(r.input_tokens)} / {number(r.output_tokens)}</td><td>{r.status === 'pending' ? '—' : (r.duration / 1000).toFixed(1) + 's'}</td><td><span title={r.error || ''} className={'request-status ' + r.status}>{r.status}</span></td><td>{new Date(r.created_at).toLocaleDateString()}</td></tr>)}</tbody></table>{!usage?.recent?.length && <p className="empty-line">No API requests yet.</p>}</div></section><p className="fine-print">Provider invoices are authoritative. Token counts for interrupted or failed requests may be unavailable even when the provider charges for partial generation.</p></div>}
 {view === 'settings' && <div className="page-inner settings-page"><div className="page-heading"><span className="eyebrow">MAKE YOURSELF AT HOME</span><h1>Your workspace, your way.</h1><p>Manage your account and the AI providers that power your conversations.</p></div><section className="data-panel account-panel"><div className="section-heading"><h2>Personal account</h2><ShieldCheck size={16}/></div><div className="account-detail"><span className="avatar large">{boot.user?.name?.slice(0, 2).toUpperCase() || 'P'}</span><div><strong>{boot.user?.name || 'Welcome to Prism'}</strong><p>{boot.user?.email || 'Sign in with ChatGPT to save conversations across devices.'}</p></div>{boot.user ? <a className="secondary-button" href="/signout-with-chatgpt?return_to=%2F" target="_top"><LogOut size={14}/>Sign out</a> : <a className="primary-button" href="/signin-with-chatgpt?return_to=%2Fsettings" target="_top">Sign in with ChatGPT <ArrowUpRight size={14}/></a>}</div></section><div className="section-heading provider-heading"><div><h2>AI connections</h2><p>Keys are configured as server secrets and never sent to the browser.</p></div><span className="count-label">{connected} of 3</span></div>{(Object.entries(PROVIDERS) as [
        Provider,
        typeof PROVIDERS[Provider]
    ][]).map(([p, v]) => <section className="provider-setting" key={p}><div className="provider-setting-top"><Mark provider={p}/><div><h3>{v.name}</h3><p>{v.description}</p></div>{providerStatus(p)}</div><div className="provider-secret"><code>{v.secret}</code><span>{boot.providers[p].configured ? 'Server secret is configured' : 'Add this server secret to enable live responses'}</span><a href={v.url} target="_blank" rel="noreferrer">Provider console <ArrowUpRight size={13}/></a></div></section>)}<div className="info-panel"><ShieldCheck size={20}/><div><strong>API access is separate from chat subscriptions.</strong><p>Prism connects directly to provider APIs. A ChatGPT, Claude, or Gemini consumer subscription does not supply API credits. Each provider needs an API account, an enabled model, and sufficient quota. Providers may charge for requests.</p><button className="text-button" onClick={() => go('/billing')}>View API billing information <ArrowRight size={13}/></button></div></div><div className="settings-links">{boot.user && <button className="danger-hover" onClick={async () => { if (!window.confirm('모든 대화와 업로드 파일을 삭제할까요? 결제·사용량 원장은 정산을 위해 보존되며 ChatGPT 계정은 삭제되지 않습니다.'))
        return; try {
        const result = await api('account/data', { method: 'DELETE' });
        setChats([]);
        setFiles([]);
        setMessages([]);
        setAttached([]);
        setNotice(result.message);
    }
    catch (e) {
        setError((e as Error).message);
    } }}>대화·파일 전체 삭제</button>}<button onClick={() => go('/privacy')}>Privacy</button><button onClick={() => go('/terms')}>Terms</button><button onClick={() => go('/faq')}>Help & FAQ</button>{boot.isAdmin && <button onClick={() => go('/admin')}>Administration</button>}</div></div>}
 {view === 'billing' && (boot.beta ? <div className="page-inner"><h1>Free beta allowance</h1><p>GPT-6.1 Sol is included at no charge. Up to 20 requests per day, subject to the daily allowance and overall beta capacity. Two responses can run at once. Responses are limited to 1,024 output tokens; conversations support 16 KB of total text.</p><p>Customer payments are disabled. Deleting conversations does not reset your allowance.</p></div> : <BillingPanel />)}
 {view === 'admin' && boot.isAdmin && <BillingPanel admin/>}
 {view === 'admin' && <div className="page-inner"><div className="page-heading"><span className="eyebrow">PLATFORM OPERATIONS</span><h1>Administration</h1><p>Restricted server-side to the configured administrator account.</p></div>{admin ? <><div className="stats-grid">{['requests', 'users', 'tokens'].map(k => <div className="stat-card" key={k}><div>{k}</div><strong>{number(admin.totals?.[k])}</strong></div>)}</div><section className="data-panel"><h2>Recent provider operations</h2><div className="table-scroll"><table><thead><tr><th>Model</th><th>Status</th><th>Error</th></tr></thead><tbody>{admin.logs.map((l: any, i: number) => <tr key={i}><td>{l.model}</td><td>{l.status}</td><td>{l.error || '—'}{l.status === 'error' && <button className="text-button" onClick={async () => { const input = window.prompt('제공사에서 확인한 입력 토큰 수'); if (input === null)
        return; const output = window.prompt('제공사에서 확인한 출력·추론 토큰 수'); if (output === null)
        return; if (!window.confirm('확인된 사용량으로 예약 잔액을 정산할까요?'))
        return; try {
        await api('admin/reconcile', post({ requestId: l.id, input: Number(input), output: Number(output), confirmed: true }));
        setAdmin(await api('admin'));
        setNotice('잔액 정산을 완료했습니다.');
    }
    catch (e) {
        setError((e as Error).message);
    } }}>사용량 확인 후 정산</button>}</td></tr>)}</tbody></table></div></section></> : <Empty icon={<ShieldCheck />} title="Administrator access required" text="An administrator must set ADMIN_USER_ID to their authenticated account ID as a server secret."/>}</div>}
 {['privacy', 'terms', 'faq'].includes(view) && <div className="page-inner legal"><div className="page-heading"><span className="eyebrow">A LITTLE CLARITY</span><h1>{view === 'privacy' ? 'Your data in Prism.' : view === 'terms' ? 'How this workspace works.' : 'A few helpful answers.'}</h1><p>Release information · October 16, 2026</p></div>{(view === 'privacy' ? [['What is stored?', 'Your authenticated account ID, conversations, uploaded text files, and provider-reported usage are stored in this site’s database and object storage. Provider API keys are server secrets and are never returned to the browser.'], ['Where do prompts go?', 'When you send a message, your conversation context and selected attachments are transmitted to the provider you select. Comparison sends the prompt to every selected provider. Each provider’s own data processing terms apply.'], ['How can I delete my data?', 'Delete conversations from Chat history and documents from My files. Usage records remain for operational accounting and enforcing beta limits. Use Settings to delete all conversations and uploaded files. Avoid entering sensitive personal information. This does not delete your ChatGPT account. Accounting records remain for reconciliation; their retention and deletion policy must be finalized before commercial launch. Customer support is not configured yet.'], ['Deployment access', 'The site can be visited publicly. ChatGPT sign-in is required for AI requests and saved conversations. Data access is additionally checked by account ID on the server.']] : view === 'terms' ? [['Independent API workspace', 'Prism is an independent interface to third-party AI APIs. It is not ChatGPT, Claude, or the Gemini consumer app and does not transfer a consumer subscription or its benefits.'], ['Model access and usage', 'Models are available only when the configured API account has access and sufficient quota. Responses can be inaccurate. You are responsible for checking results and for using providers in accordance with their applicable terms.'], ['Charges and limits', 'Requests consume the configured provider’s API quota and may incur fees, including interrupted responses. Comparison makes a separate billable request for each selected model. Prism is being prepared for prepaid credit purchases of KRW 10,000, 30,000, or 50,000. No subscription renewals are used. Sales remain disabled until pricing, refunds, seller information, and merchant setup are complete.'], ['Before a public launch', 'Operator: 종합상사 루비; representative: 노휘석. Registration number, address, customer support, deduction rates, refund terms and credit validity are pending. Commercial sales are disabled. The free beta has server-enforced allowances and no customer payments.']] : [['Do I need ChatGPT Plus or Pro?', 'Prism uses API access, which is separate from ChatGPT subscriptions. You need ChatGPT sign-in to use AI and save conversations. The provider API account supplies the model access and quota.'], ['How do I choose a model?', 'Open the model selector below your message, or explore the Model library. The model label is the actual configured API model. You can change models within a conversation.'], ['What do Pro and Extra High do?', 'For supported OpenAI models, Pro selects the API reasoning mode and Extra High selects reasoning effort. They can increase latency and API usage. They do not reproduce every feature of a ChatGPT subscription.'], ['Can I compare answers?', 'Yes. Select two or three different models in Compare models, then send one prompt. Each real response is shown independently. Provider connections are required.'], ['Which files can I upload?', 'Plain text, Markdown, CSV, JSON, and supported source code files up to 128 KB. Attach up to three files per message. PDF and image processing are not enabled.'], ['Why does a provider say Not connected?', 'The matching API key has not been configured as a server secret. Settings shows the required secret names and provider console links. No synthetic AI replies are generated.']]).map(([title, text]) => <section className="legal-section" key={title}><h2>{title}</h2><p>{text}</p></section>)}</div>}
 {view === 'auth' && <div className="page-inner"><Empty icon={<ShieldCheck />} title="A workspace for your best ideas." text="Sign in with ChatGPT to save your conversations, compare models, and keep your documents together." action={<a className="primary-button" href="/signin-with-chatgpt?return_to=%2Fchat" target="_top">Continue with ChatGPT <ArrowUpRight size={15}/></a>}/><p className="fine-print">Authentication is managed by ChatGPT. Account creation and password recovery are handled there.</p></div>}
 {!secondaryView && !['chat', 'compare', 'models', 'history', 'files', 'usage', 'settings', 'billing', 'admin', 'privacy', 'terms', 'faq', 'auth'].includes(view) && <Empty icon={<Search />} title="This page wandered off." text="Head back to your workspace to start again." action={<button className="primary-button" onClick={() => go('/chat')}>Back to workspace</button>}/>}
 {secondaryView && <SettingsPages pathname={pathname} signedIn={!!boot.user} onNavigate={go} onNotice={setNotice} onError={setError}/>}
 </main><footer className="app-footer"><span>{boot.beta ? 'Free beta · GPT-6.1 Sol · Daily allowance applies' : 'Room for your next big idea.'}</span><span>Made for curious minds <span className="footer-spark">✦</span></span></footer></div>
 <ChatSearchDialog open={searchOpen} onOpenChange={setSearchOpen} onNavigate={go} signedIn={!!boot.user}/>
 <NotebookDialog open={notebookOpen} onOpenChange={setNotebookOpen} onCreate={createNotebook}/>
 {shareOpen && <Modal title="대화 공유" close={() => { if (!shareBusy) setShareOpen(false); }}><p className="modal-intro">공개 링크를 아는 누구나 현재 대화의 사본을 볼 수 있습니다. 첨부 파일 원문은 제외되지만, 메시지에 작성하거나 인용한 내용은 공개됩니다. 이후의 새 메시지는 추가되지 않습니다.</p>{shareUrl ? <><label className="prism-share-url-label">공개 링크<input readOnly value={shareUrl} onFocus={event => event.currentTarget.select()}/></label><div className="modal-actions"><button className="secondary-button" onClick={() => copy(shareUrl)}><Copy size={15}/>링크 복사</button><button className="primary-button" onClick={() => { setShareOpen(false); go('/sharing'); }}>공개 링크 관리</button></div></> : <><p className="fine-print">내 공개 링크에서 언제든지 공유를 취소할 수 있습니다.</p>{shareError && <p className="prism-form-error" role="alert">{shareError}</p>}<div className="modal-actions"><button className="secondary-button" disabled={shareBusy} onClick={() => setShareOpen(false)}>취소</button><button className="primary-button" disabled={shareBusy} onClick={createShare}>{shareBusy ? '생성 중…' : '공개 링크 만들기'}</button></div></>}</Modal>}
 {notice && <div className="toast" role="status"><CheckCircle2 size={16}/>{notice}</div>}
 {help && <Modal title="A little guide to Prism" close={() => setHelp(false)}><p className="modal-intro">Your next big idea is a conversation away.</p><div className="guide-steps">{[[MessageSquare, 'Start with a question', 'Choose a model, set your reasoning level, and send your prompt.'], [Columns2, 'Get another perspective', 'Compare two or three models with the same prompt.'], [FolderOpen, 'Bring your context', 'Upload a text document and attach it to any conversation.']].map(([Icon, title, text]: any) => <div key={title}><span><Icon size={20}/></span><div><h3>{title}</h3><p>{text}</p></div></div>)}</div><div className="guide-note"><PlugZap size={18}/><p>{connected ? 'Your configured providers are ready for API requests.' : 'Connect provider API accounts in Settings to enable real responses.'}</p></div><button className="primary-button full" onClick={() => { setHelp(false); go(connected ? '/chat' : '/settings'); }}>{connected ? 'Let’s get started' : 'Go to connections'}<ArrowRight size={15}/></button></Modal>}
 {deleteTarget && <Modal title={'Delete ' + (deleteTarget.kind === 'files' ? 'document' : 'conversation') + '?'} close={() => setDeleteTarget(null)}><p className="modal-intro">“{deleteTarget.title}” will be permanently removed from your workspace.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setDeleteTarget(null)}>Keep it</button><button className="danger-button" onClick={remove}><Trash2 size={14}/>Delete</button></div></Modal>}
 {rename && <Modal title="Rename conversation" close={() => setRename(null)}><form onSubmit={async (e) => { e.preventDefault(); try {
        await api('conversations/' + rename.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: rename.title }) });
        loadChats();
        setRename(null);
    }
    catch (e) {
        setError((e as Error).message);
    } }}><input className="rename-input" autoFocus aria-label="Conversation title" value={rename.title} maxLength={100} onChange={e => setRename({ ...rename, title: e.target.value })}/><button className="primary-button full" disabled={!rename.title.trim()}>Save title <Check size={14}/></button></form></Modal>}
 </div>;
}
function Empty({ icon, title, text, action }: {
    icon: ReactNode;
    title: string;
    text: string;
    action?: ReactNode;
}) { return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{text}</p>{action}</div>; }
function Modal({ title, children, close }: {
    title: string;
    children: ReactNode;
    close: () => void;
}) { const ref = useRef<HTMLDivElement>(null); useEffect(() => { const previous = document.activeElement as HTMLElement | null; const el = ref.current; el?.focus(); function trap(e: KeyboardEvent) { if (e.key === 'Tab' && el) {
    const nodes = el.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea');
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
    }
    else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
    }
} } document.addEventListener('keydown', trap); return () => { document.removeEventListener('keydown', trap); previous?.focus(); }; }, []); return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget)
    close(); }}><div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><div className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><X size={19}/></button></div>{children}</div></div>; }
