'use client';
import { lazy, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useWorkspaceNavigation } from '../hooks/use-workspace-navigation';
import { useCopyFeedback } from '../hooks/use-copy-feedback';
import { useShellPerformance } from '../hooks/use-shell-performance';
import { useStaticAssetCache } from '../hooks/use-static-asset-cache';
import { isNewChatShortcut } from '../lib/workspace-navigation';
import { readChatStream } from '../lib/chat-stream';
import { conversationMarkdown } from '../lib/conversation-export';
import type { WorkspaceBootstrap } from '../lib/workspace-bootstrap';
import { ArrowUp, ArrowUpRight, ArrowRight, Plus, Search, MessageSquare, Columns2, Grid2X2, Clock3, FolderOpen, ChartNoAxesCombined, Settings2, ChevronDown, ChevronRight, Check, X, Paperclip, SlidersHorizontal, Sparkles, Code2, PenLine, Lightbulb, Brain, Copy, Download, Trash2, ExternalLink, ShieldCheck, LoaderCircle, Menu, BookOpen, Command, LogOut, PlugZap, FileText, AlertCircle, Square, Link2, CheckCircle2, RefreshCw, Wallet, MoreHorizontal } from 'lucide-react';
import { AVAILABLE_CHAT_MODELS, DEFAULT_MODEL_ID, isFreeModel, MODELS, PROVIDERS, Provider, Model, findModel } from '../lib/models';
import { notifyBillingUpdated, subscribeBillingUpdates } from '../lib/billing-sync';
import { Image, Video, Hexagon, PanelLeftClose, PanelLeftOpen, History, NotebookPen, Share2, Pin } from 'lucide-react';
import { Composer, type ComposerTool } from '../components/workspace/composer';
import type { CanvasDraft } from '../components/workspace/creative-workspace';
import { BrowserLinkGuard } from '../components/workspace/browser-link-guard';
import { PrismMark, WorkspaceHeader, NotebookDialog } from '../components/workspace/chrome';
import { SettingsMenu } from '../components/workspace/settings-menu';
import { AccountPopover } from '../components/workspace/account-popover';
import { DeferredPanel } from '../components/workspace/deferred-panel';
import { DropdownMenu } from 'radix-ui';
import GuestMarkdown from '../components/guest/guest-markdown';
import CollapsiblePrompt from '../components/chat/collapsible-prompt';
import { GuestImportNotice } from '../components/workspace/guest-import-notice';
import { ConversationActions } from '../components/workspace/conversation-actions';
import { ResponseActions } from '../components/workspace/response-actions';
import { ThinkingIndicator } from '../components/workspace/thinking-indicator';
import { useWelcomeIntro } from '../components/workspace/welcome-intro';
import type { ExportTarget, DetailTarget } from '../components/workspace/conversation-tools';
import './chat-navigation.css';
import './authenticated-desktop.css';
import '../components/workspace/sharing.css';

// Keep the chat shell, composer and menus in the entry bundle. Secondary
// workspaces and dialogs load only when needed, without suspending the shell.
const loadBilling = () => import('./billing-panel');
const loadCreative = () => import('../components/workspace/creative-workspace');
const loadSettings = () => import('../components/workspace/settings-pages');
const loadSearch = () => import('../components/workspace/chat-search');
const loadTasks = () => import('../components/workspace/task-manager');
const loadNotebooks = () => import('../components/workspace/notebook-page');
const loadBrowser = () => import('../components/workspace/browser-session');
const loadDrive = () => import('../components/workspace/drive-picker');
const loadMusic = () => import('../components/workspace/music-workspace');
const loadConversationTools = () => import('../components/workspace/conversation-tools');
const BillingPanel = lazy(loadBilling);
const CanvasPanel = lazy(() => loadCreative().then(module => ({ default: module.CanvasPanel })));
const MediaWorkspace = lazy(() => loadCreative().then(module => ({ default: module.MediaWorkspace })));
const SettingsPages = lazy(() => loadSettings().then(module => ({ default: module.SettingsPages })));
const ChatSearchDialog = lazy(() => loadSearch().then(module => ({ default: module.ChatSearchDialog })));
const TaskManager = lazy(() => loadTasks().then(module => ({ default: module.TaskManager })));
const NotebookPage = lazy(() => loadNotebooks().then(module => ({ default: module.NotebookPage })));
const BrowserSessionPage = lazy(() => loadBrowser().then(module => ({ default: module.BrowserSessionPage })));
const DrivePickerDialog = lazy(() => loadDrive().then(module => ({ default: module.DrivePickerDialog })));
const MusicWorkspace = lazy(() => loadMusic().then(module => ({ default: module.MusicWorkspace })));
const ExportDialog = lazy(() => loadConversationTools().then(module => ({ default: module.ExportDialog })));
const ResponseDetailsDialog = lazy(() => loadConversationTools().then(module => ({ default: module.ResponseDetailsDialog })));
const LegalReportDialog = lazy(() => loadConversationTools().then(module => ({ default: module.LegalReportDialog })));

function preloadWorkspaceView(path: string) {
    const view = path.split('/')[1];
    const load = ['billing', 'pricing', 'admin'].includes(view) ? loadBilling
        : ['images', 'videos'].includes(view) ? loadCreative
        : ['personalization-settings', 'gemini-spark', 'browser-settings', 'customize', 'gems', 'import', 'sharing', 'share', 'feedback'].includes(view) ? loadSettings
        : view === 'scheduled' ? loadTasks : view === 'notebooks' ? loadNotebooks
        : view === 'browser' ? loadBrowser : view === 'music' ? loadMusic : null;
    // A speculative preload must never prevent navigation or hide a real error.
    if (load) void load().catch(() => {});
}
type Chat = {
    id: string;
    title: string;
    model: string;
    updated_at: number;
    pinned_at?: number | null;
};
type Message = {
    id: string;
    /** Keep the rendered turn mounted when the server assigns its saved ID. */
    renderKey?: string;
    role: string;
    content: string;
    model?: string;
    created_at?: number;
    feedback?: 'up' | 'down' | null;
    saved?: boolean;
    prompt_text?: string;
};
type SharePreview = { conversationId: string; title: string; previewHash: string; messages: { role: string; content: string }[] };
type Revision = { action: 'edit' | 'regenerate'; messageId: string; prompt: string; model?: string; regenerateStyle?: 'longer' | 'shorter' | 'no_personalization' | 'retry' };
type PendingRecovery = { clientRequestId: string; requestId?: string; conversationId?: string; epoch: number; revision?: Revision; partialAnswer?: Message };
type FileRecord = {
    id: string;
    name: string;
    size: number;
    created_at: number;
};
type MediaRecord = {id:string;kind:'image'|'video'|'music';status:'processing'|'complete'|'error';url:string;mimeType:string;prompt:string;error?:string;createdAt:number};
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
const nav = [{ path: '/chat', label: 'New chat', icon: MessageSquare }, { path: '/compare', label: 'Compare models', icon: Columns2 }, { path: '/models', label: 'Model library', icon: Grid2X2 }];
const worknav = [{ path: '/history', label: 'Chat history', icon: Clock3 }, { path: '/files', label: 'My files', icon: FolderOpen }, { path: '/usage', label: 'Usage', icon: ChartNoAxesCombined }, { path: '/billing', label: '충전 및 잔액', icon: Wallet }];
function Mark({ provider, size = 'normal' }: {
    provider: Provider | 'prism';
    size?: string;
}) { return <span className={'model-mark ' + provider + ' ' + size}>{provider === 'openai' ? <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">{[0, 60, 120].map(a => <rect key={a} x="10" y="3" width="12" height="26" rx="6" stroke="currentColor" strokeWidth="1.8" transform={'rotate(' + a + ' 16 16)'}/>)}</svg> : provider === 'anthropic' ? <svg viewBox="0 0 32 32" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <path key={i} d="M16 3v9" transform={'rotate(' + i * 30 + ' 16 16)'} stroke="currentColor" strokeWidth="2.2"/>)}<circle cx="16" cy="16" r="4" fill="currentColor"/></svg> : provider === 'google' ? <svg viewBox="0 0 32 32" aria-hidden="true"><text x="16" y="23" textAnchor="middle" fontFamily="Arial, sans-serif" fontSize="24" fontWeight="700" fill="currentColor">G</text></svg> : <PrismMark size={32}/>}</span>; }
class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}
async function api(path: string, options?: RequestInit): Promise<any> { const r = await fetch('/api/' + path, options); let d: any; try {
    d = await r.json();
}
catch {
    throw new Error('서버 응답을 읽지 못했습니다. 다시 시도해주세요.');
} if (!r.ok)
    throw new ApiError(d.error || '요청을 처리하지 못했습니다.', r.status); return d; }
const post = (data: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const number = (n: number) => new Intl.NumberFormat('en-US').format(n || 0);
function TextResponse({ text }: { text: string }) {
    return <div className="response-text"><GuestMarkdown text={text}/></div>;
}
export default function Workspace({ initialPathname = '/', initialBootstrap, initialChats }: {
    initialPathname?: string;
    initialBootstrap: WorkspaceBootstrap;
    initialChats: Chat[] | null;
}) {
    useShellPerformance();
    useStaticAssetCache();
    const { pathname, navigate } = useWorkspaceNavigation(initialPathname);
    const rawView = pathname.split('/')[1] || 'chat', view = ({ library: 'history', pricing: 'billing', login: 'auth', signup: 'auth', 'forgot-password': 'auth', docs: 'faq' } as Record<string, string>)[rawView] || rawView, chatId = view === 'chat' ? pathname.split('/')[2] : undefined;
    // The page has already verified the request and supplied its public configuration.
    // Use the same state for SSR and hydration instead of briefly inventing a guest.
    const boot = initialBootstrap, ready = true;
    const [chats, setChats] = useState<Chat[]>(initialChats ?? []), [files, setFiles] = useState<FileRecord[]>([]);
    const [chatsLoading, setChatsLoading] = useState(initialChats === null), [chatsError, setChatsError] = useState('');
    const [historyTimeZone, setHistoryTimeZone] = useState('UTC');
    const [modelId, setModelId] = useState(DEFAULT_MODEL_ID), [effort, setEffort] = useState('minimal'), [pro, setPro] = useState(false), [modelOpen, setModelOpen] = useState(false), [modelQuery, setModelQuery] = useState('');
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
    const [composerTool, setComposerTool] = useState<ComposerTool>('chat');
    const [researchSources, setResearchSources] = useState({web:true});
    const [videoAspect, setVideoAspect] = useState<'16:9'|'9:16'>('16:9');
    const [mediaAssets,setMediaAssets]=useState<MediaRecord[]>([]);
    const [mediaReference,setMediaReference]=useState<{id:string;name:string;url:string}|null>(null);
    const [driveOpen,setDriveOpen]=useState(false);
    const mediaUploadRef=useRef<HTMLInputElement>(null);
    const [canvasDrafts, setCanvasDrafts] = useState<Record<string,CanvasDraft>>({});
    const [workspaceDeleting,setWorkspaceDeleting]=useState(false);
    const [workspaceDeletion,setWorkspaceDeletion]=useState<{status:string;message:string;activeOperations?:number;lastErrorCode?:string|null;workerRunning?:boolean}|null>(null);
    const [searchOpen, setSearchOpen] = useState(false);
    const [collapsed, setCollapsed] = useState(false);
    const [notebookOpen, setNotebookOpen] = useState(false);
    const [walletBalance, setWalletBalance] = useState<number | null>(null);
    const [selectedSkill, setSelectedSkill] = useState<{id:string;name:string} | null>(null);
    const [shareOpen, setShareOpen] = useState(false);
    const [shareBusy, setShareBusy] = useState(false);
    const [shareUrl, setShareUrl] = useState('');
    const [shareError, setShareError] = useState('');
    const [sharePreview, setSharePreview] = useState<SharePreview | null>(null);
    const [sharePreviewLoading, setSharePreviewLoading] = useState(false);
    const [sharePreviewAttempt, setSharePreviewAttempt] = useState(0);
    const [shareReviewed, setShareReviewed] = useState(false);
    const [shareExpiry, setShareExpiry] = useState('7');
    const [shareExpiresAt, setShareExpiresAt] = useState<number | null>(null);
    const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
    const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
    const [reportTarget, setReportTarget] = useState<DetailTarget | null>(null);
    const [editingMessage, setEditingMessage] = useState<{ id: string; content: string } | null>(null);
    const [pdfBusy, setPdfBusy] = useState(false);
    const [pendingRecovery, setPendingRecovery] = useState<PendingRecovery | null>(null), [recovering, setRecovering] = useState(false);
    const pinRequests = useRef(new Set<string>());
    const { copy, isCopied, copyNotice, copyNoticeKey, resetCopyFeedback } = useCopyFeedback(pathname, setError, id => {
        if (id === 'share-link') return shareUrl;
        if (id.startsWith('compare-')) return results[id.slice(8)]?.text;
        const message = messages.find(message => message.id === id);
        return message?.role === 'user' ? message.prompt_text ?? message.content : message?.content;
    });
    const [loadedChatId, setLoadedChatId] = useState<string>();
    useEffect(() => {
        if (!shareOpen || !chatId) return;
        const controller = new AbortController();
        setSharePreview(null); setShareReviewed(false); setShareError(''); setSharePreviewLoading(true);
        api('shares/preview?conversationId=' + encodeURIComponent(chatId), { signal: controller.signal })
            .then((value: SharePreview) => { if (!controller.signal.aborted) setSharePreview(value); })
            .catch(failure => { if (!controller.signal.aborted) setShareError(failure instanceof Error ? failure.message : '미리보기를 불러오지 못했습니다.'); })
            .finally(() => { if (!controller.signal.aborted) setSharePreviewLoading(false); });
        return () => controller.abort();
    }, [shareOpen, chatId, sharePreviewAttempt]);
    const [chatLoadError, setChatLoadError] = useState('');
    const [chatRetry, setChatRetry] = useState(0);
    const [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState('');
    const [renaming, setRenaming] = useState(false), [renameError, setRenameError] = useState('');
    const chatLoadController = useRef<AbortController | null>(null);
    const chatsRequest = useRef(0);
    const initialChatsMissing = useRef(initialChats === null);
    const previousListPath = useRef(pathname);
    const currentPath = useRef(pathname);
    const navigationEpoch = useRef(0);
    if (currentPath.current !== pathname) { currentPath.current = pathname; navigationEpoch.current++; }
    useEffect(() => { setEditingMessage(null); setExportTarget(null); setDetailTarget(null); setReportTarget(null); setPendingRecovery(null); setRecovering(false); }, [pathname]);
    const streamPath = useRef(pathname);
    const newChatRef = useRef(newChat);
    newChatRef.current = newChat;
    const mutationPending = useRef(false);
    mutationPending.current = deleting || renaming;
    const mainRef = useRef<HTMLElement>(null);
    const sidebarRef = useRef<HTMLElement>(null);
    const pendingTurnMotion = useRef<{ key: string; composerRect: DOMRect | null } | null>(null);
    const followBottom = useRef(true);
    const abortRef = useRef<AbortController | null>(null), endRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLTextAreaElement>(null), uploadRef = useRef<HTMLInputElement>(null), runningId = useRef<string | undefined>(undefined);
    useEffect(() => () => abortRef.current?.abort(), []);
    const availableModels = boot.models ?? AVAILABLE_CHAT_MODELS;
    const selected = findModel(modelId) || findModel(DEFAULT_MODEL_ID)!, connected = Object.values(boot.providers).filter(p => p.configured).length;
    const capabilities = boot.capabilities ?? {webResearch:false,image:false,video:false,remoteBrowser:false};
    const activeTool = view === 'compare' ? 'chat' : view === 'images' ? 'image' : view === 'videos' ? 'video' : composerTool;
    const welcomePhase = useWelcomeIntro({ active: view === 'chat' && !chatId && messages.length === 0 && composerTool === 'chat', ready });
    useEffect(() => {
        if(view!=='settings'||!boot.user)return;
        let current=true;
        void api('account/data').then(result=>{if(current)setWorkspaceDeletion(result.deletion);}).catch(()=>{});
        return ()=>{current=false;};
    },[view,boot.user?.email]);
    async function eraseWorkspaceData() {
        if(workspaceDeleting)return;
        if(workspaceDeletion?.status!=='pending'&&!window.confirm('모든 대화와 업로드 파일을 삭제할까요? 로그인 정보와 결제·사용량 원장은 유지되며 Google 계정은 삭제되지 않습니다.'))return;
        setWorkspaceDeleting(true);setError('');
        try {
            let result;
            for(let pass=0;pass<5;pass++){
                result=await api('account/data',{method:'DELETE'});
                setWorkspaceDeletion(result);
                if(result.status==='complete'||result.activeOperations||result.lastErrorCode||result.workerRunning)break;
            }
            setChats([]);setFiles([]);setMessages([]);setAttached([]);setMediaAssets([]);setMediaReference(null);
            setCanvasDrafts({});setPrompt('');setEditingMessage(null);setSelectedSkill(null);runningId.current=undefined;
            try {
                const prefix='prism-canvas:v1:'+encodeURIComponent(boot.user?.email||'guest')+':';
                const keys=Array.from({length:sessionStorage.length},(_,index)=>sessionStorage.key(index));
                for(const key of keys)if(key?.startsWith(prefix))sessionStorage.removeItem(key);
                sessionStorage.removeItem('prism-signin-draft');
            }catch{}
            setNotice(result?.message||'삭제 상태를 확인해주세요.');
        }catch(failure){setError(failure instanceof Error?failure.message:'삭제 상태를 확인하지 못했습니다. 다시 시도해주세요.');}
        finally{setWorkspaceDeleting(false);}
    }
    const canvasKey = 'prism-canvas:v1:' + encodeURIComponent(boot.user?.email || 'guest') + ':' + (chatId || runningId.current || 'draft');
    function rememberDraft(){
        try{sessionStorage.setItem('prism-signin-draft',JSON.stringify({prompt,tool:activeTool,workspaceMode,researchSources,videoAspect,savedAt:Date.now()}));}catch{}
    }
    useEffect(()=>{
        if(!ready||!boot.user)return;
        try{
            const draft=JSON.parse(sessionStorage.getItem('prism-signin-draft')||'null');
            if(draft&&typeof draft.prompt==='string'&&draft.prompt.length<=32000&&Date.now()-draft.savedAt<3600000){
                setPrompt(draft.prompt);
                if(['chat','canvas','research','learning','image','video'].includes(draft.tool))setComposerTool(draft.tool);
                if(draft.workspaceMode==='work')setWorkspaceMode('work');
                if(typeof draft.researchSources?.web==='boolean')setResearchSources({web:draft.researchSources.web});
                if(draft.videoAspect==='9:16')setVideoAspect('9:16');
            }
            sessionStorage.removeItem('prism-signin-draft');
        }catch{}
    },[ready,boot.user?.email]);
    useEffect(()=>{
        const viewport=window.visualViewport;
        if(!viewport)return;
        const update=()=>{
            if(window.innerWidth<=767&&Math.abs(viewport.scale-1)<0.02)document.documentElement.style.setProperty('--prism-viewport-height',`${viewport.height}px`);
            else document.documentElement.style.removeProperty('--prism-viewport-height');
        };
        update();viewport.addEventListener('resize',update);window.addEventListener('resize',update);
        return()=>{viewport.removeEventListener('resize',update);window.removeEventListener('resize',update);document.documentElement.style.removeProperty('--prism-viewport-height');};
    },[]);
    const loadMedia=useCallback(async()=>{const data=await api('media');setMediaAssets(data.assets||[]);},[]);
    useEffect(()=>{
        if(ready&&boot.user&&['images','videos','music'].includes(view))loadMedia().catch(cause=>setError(cause.message));
    },[ready,boot.user?.email,view,loadMedia]);
    const pendingMedia=mediaAssets.filter(asset=>asset.status==='processing').map(asset=>asset.id).join(',');
    useEffect(()=>{
        if(!boot.user||!pendingMedia)return;
        const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;let attempts=0;
        const poll=async()=>{
            const refreshed=await Promise.allSettled(pendingMedia.split(',').map(id=>api('media/'+id+'/refresh',{method:'POST',signal:controller.signal})));
            if(controller.signal.aborted)return;
            setMediaAssets(current=>current.map(asset=>{const index=pendingMedia.split(',').indexOf(asset.id);const value=refreshed[index];return value?.status==='fulfilled'?value.value:asset;}));
            if(++attempts<60)timer=setTimeout(poll,10000);
            else setNotice('생성 작업은 계속 진행됩니다. 페이지를 다시 열면 최신 결과를 확인할 수 있습니다.');
        };
        timer=setTimeout(poll,5000);return()=>{controller.abort();clearTimeout(timer);};
    },[pendingMedia,boot.user?.email]);
    useEffect(() => {
        try {
            const stored = JSON.parse(sessionStorage.getItem(canvasKey) || 'null');
            if (stored && typeof stored.text === 'string' && stored.text.length <= 100000 && typeof stored.saved === 'boolean') setCanvasDrafts(current => ({...current,[canvasKey]:stored}));
        } catch {}
    }, [canvasKey]);
    function updateCanvasDraft(draft: CanvasDraft | null) {
        setCanvasDrafts(current => { const next = {...current}; if (draft) next[canvasKey] = draft; else delete next[canvasKey]; return next; });
        try { if (draft) sessionStorage.setItem(canvasKey,JSON.stringify(draft)); else sessionStorage.removeItem(canvasKey); }
        catch { setNotice('초안은 현재 화면에 보관됩니다. 탭을 새로 열기 전에 파일로 저장해 주세요.'); }
    }
    function reviseCanvas(text: string) {
        const revision = '다음 초안을 개선해 주세요. 의미는 유지하고 더 명확하게 다듬어 주세요.\n\n' + text;
        if (revision.length > 32000) { setError('초안이 메시지 한도를 넘습니다. 먼저 Canvas를 파일로 저장한 뒤 첨부된 문서를 바탕으로 수정을 요청해 주세요.'); return; }
        setPrompt(revision); inputRef.current?.focus();
    }
    useEffect(() => {
        if (view === 'videos') { setComposerTool('video'); return; }
        if (view === 'images') { setComposerTool('image'); return; }
        if (view !== 'chat') return;
        try {
            const stored = localStorage.getItem('prism-tool:' + (chatId || 'draft'));
            setComposerTool(stored && ['chat','canvas','research','learning','image','video'].includes(stored) ? stored as ComposerTool : 'chat');
        } catch { setComposerTool('chat'); }
    }, [view, chatId]);
    function selectTool(tool: ComposerTool) {
        if (busy) return;
        setComposerTool(tool);
        try { localStorage.setItem('prism-tool:' + (chatId || 'draft'), tool); } catch {}
        if (tool === 'image') { if(view !== 'images') go('/images'); }
        else if(tool === 'video') { if(view !== 'videos') go('/videos'); }
        else if (view === 'images' || view === 'videos') go('/chat');
    }
    const loadChats = useCallback(async (signal?: AbortSignal) => {
        const request = ++chatsRequest.current;
        setChatsLoading(true); setChatsError('');
        try {
            const result = await api('conversations', { cache: 'no-store', signal });
            if (!signal?.aborted && request === chatsRequest.current) setChats(result);
        } catch (cause) {
            if (!signal?.aborted && request === chatsRequest.current) setChatsError(cause instanceof Error ? cause.message : '대화 목록을 불러오지 못했습니다.');
        } finally {
            if (!signal?.aborted && request === chatsRequest.current) setChatsLoading(false);
        }
    }, []);
    const loadFiles = useCallback(async () => { try {
        setFiles(await api('files'));
    }
    catch { } }, []);
    useEffect(() => {
        if (!ready || !boot.user) { setWalletBalance(null); return; }
        let active = true;
        let current: AbortController | undefined;
        const refresh = () => {
            current?.abort();
            current = new AbortController();
            api('billing', { cache: 'no-store', signal: current.signal }).then(data => {
                if (active && Number.isSafeInteger(data.balance)) setWalletBalance(data.balance);
            }).catch(() => { /* Keep the last server-confirmed balance until the next refresh. */ });
        };
        refresh();
        const unsubscribe = subscribeBillingUpdates(refresh);
        return () => { active = false; current?.abort(); unsubscribe(); };
    }, [ready, boot.user?.email, busy]);
    useEffect(() => {
        const controller = new AbortController();
        // Match the server on hydration, then format history dates in the visitor's zone.
        setHistoryTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
        // A successful server read needs no duplicate browser request on arrival.
        // Recover history independently if the server's short prefetch budget expired.
        if (initialChatsMissing.current) void loadChats(controller.signal);
        void loadFiles();
        return () => { controller.abort(); chatsRequest.current++; };
    }, [loadChats, loadFiles]);
    useEffect(() => {
        const routeChanged = previousListPath.current !== pathname;
        previousListPath.current = pathname;
        const controller = new AbortController();
        chatLoadController.current?.abort();
        chatLoadController.current = controller;
        if (abortRef.current && pathname !== streamPath.current && !(chatId && chatId === runningId.current)) stopForNavigation();
        if (chatId !== runningId.current) runningId.current = undefined;
        setMobile(false);
        // A newly created chat keeps its stop/error notice when its URL is assigned.
        if (!(chatId && chatId === runningId.current)) setError('');
        setChatLoadError('');
        setSearch('');
        setModelOpen(false);
        if (view === 'models' && ['openai', 'anthropic', 'google'].includes(pathname.split('/')[2] || ''))
            setFilter(pathname.split('/')[2]);
        if (view === 'chat') {
            if (chatId && chatId !== runningId.current) {
                setLoadedChatId(undefined);
                api('conversations/' + encodeURIComponent(chatId), { signal: controller.signal, cache: 'no-store' }).then(d => {
                    if (controller.signal.aborted || chatLoadController.current !== controller) return;
                    setMessages(d.messages);
                    setModelId(availableModels.some(model => model.id === d.conversation.model) ? d.conversation.model : DEFAULT_MODEL_ID);
                    setLoadedChatId(chatId);
                    setChats(current => current.some(chat => chat.id === chatId)
                        ? current.map(chat => chat.id === chatId ? { ...chat, ...d.conversation } : chat)
                        : [d.conversation, ...current]);
                }).catch(e => {
                    if (!controller.signal.aborted && chatLoadController.current === controller) setChatLoadError(e.message);
                });
            }
            else if (!chatId && !abortRef.current) {
                setMessages([]);
                setLoadedChatId(undefined);
                runningId.current = undefined;
            }
        }
        if (view === 'usage')
            api('usage').then(setUsage).catch(e => setError(e.message));
        if (view === 'files' && routeChanged)
            loadFiles();
        if (view === 'history' && routeChanged)
            void loadChats();
        if (view === 'admin')
            api('admin').then(setAdmin).catch(e => setError(e.message));
        return () => controller.abort();
    }, [pathname, chatRetry]);
    useEffect(() => { if (!selected.efforts.includes(effort))
        setEffort(selected.efforts.includes('medium') ? 'medium' : selected.efforts[0] || 'medium'); if (!selected.pro)
        setPro(false); }, [modelId]);
    useEffect(() => { if (view === 'compare' && !['low','medium','high'].includes(effort)) setEffort('medium'); }, [view,effort]);
    const lastUserMessage = messages.findLast(message => message.role === 'user');
    const lastUserKey = lastUserMessage?.renderKey ?? lastUserMessage?.id;
    useLayoutEffect(() => {
        if (!lastUserKey || view !== 'chat') return;
        const container = mainRef.current;
        if (!container) return;
        const pending = pendingTurnMotion.current?.key === lastUserKey ? pendingTurnMotion.current : null;
        pendingTurnMotion.current = null;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (composerTool === 'canvas') {
            if (followBottom.current) endRef.current?.scrollIntoView({ behavior: 'instant' });
            return;
        }
        const latestPrompt = Array.from(container.querySelectorAll<HTMLElement>('.prism-thread .message.user')).at(-1);
        if (latestPrompt) {
            const top = latestPrompt.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 16;
            // Move once for a submitted turn. Streaming text and saved IDs never
            // pull the reader away from the passage they are reading.
            container.scrollTo({ top: Math.max(0, top), behavior: pending && !reducedMotion ? 'smooth' : 'instant' });
        }
        const composer = container.querySelector<HTMLElement>('.chat-composer .gemini-compose-wrap');
        if (!pending?.composerRect || !composer || reducedMotion || typeof composer.animate !== 'function') return;
        const from = pending.composerRect;
        const to = composer.getBoundingClientRect();
        if (!to.width || !from.width) return;
        // The welcome and thread share the same visible composer; carry its
        // geometry across the layout change instead of snapping to the footer.
        const animation = composer.animate([
            { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scaleX(${from.width / to.width})`, transformOrigin: 'top left' },
            { transform: 'translate(0, 0) scaleX(1)', transformOrigin: 'top left' },
        ], { duration: 320, easing: 'cubic-bezier(.2, 0, 0, 1)' });
        return () => animation.cancel();
    }, [lastUserKey, composerTool, view]);
    useEffect(() => {
        if (composerTool === 'canvas' && messages.length && followBottom.current) endRef.current?.scrollIntoView({ behavior: 'instant' });
    }, [messages, composerTool]);
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
    useEffect(() => { const fn = (e: KeyboardEvent) => {
      if (isNewChatShortcut(e)) {
        e.preventDefault(); e.stopPropagation(); newChatRef.current(); return;
      }
      if (e.defaultPrevented) return; if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
    } if (e.key === 'Escape') {
        if (document.querySelector('[role="menu"][data-state="open"],[role="dialog"][data-state="open"]')) return;
        setHelp(false);
        setSearchOpen(false);
        setModelOpen(false);
        setMobile(false);
        if (!mutationPending.current) { setDeleteTarget(null); setRename(null); }
    } }; window.addEventListener('keydown', fn, true); return () => window.removeEventListener('keydown', fn, true); }, []);
    function stopForNavigation() {
        pendingTurnMotion.current = null;
        const previous = abortRef.current;
        abortRef.current = null;
        previous?.abort();
        setBusy(false);
    }
    const go = (path: string) => {
        preloadWorkspaceView(path);
        if (path !== pathname) {
            navigationEpoch.current++;
            stopForNavigation();
            chatLoadController.current?.abort();
            chatLoadController.current = null;
            runningId.current = undefined;
            setChatLoadError('');
        }
        setMobile(false);
        navigate(path);
    };
    function choose(m: Model) {
        setModelOpen(false); setModelQuery('');
        if (!isFreeModel(m.id) && (!boot.user || walletBalance === null || walletBalance <= 0)) {
            if (boot.user && walletBalance === null) { setError('크레딧 잔액을 확인하고 있습니다. 잠시 후 다시 선택해주세요.'); return false; }
            rememberDraft(); go('/upgrade'); return false;
        }
        setModelId(m.id); setEffort(isFreeModel(m.id) ? 'minimal' : 'medium'); return true;
    }
    function example(value: string) { setPrompt(value); inputRef.current?.focus(); }
    async function stream(model: string, conversationId: string | undefined, signal: AbortSignal, onEvent: (data: any) => void, revision?: Revision, clientRequestId = crypto.randomUUID()) {
        const r = await fetch('/api/chat', { ...post({ model, prompt: revision?.prompt ?? prompt, effort: findModel(model)?.efforts.includes(effort) ? effort : 'medium', pro: findModel(model)?.pro ? pro : false, conversationId, fileIds: revision ? [] : attached, workspaceMode, skillId:selectedSkill?.id, tool: revision ? 'chat' : activeTool, researchSources: revision ? { web: false } : researchSources, generateTitle: view === 'chat', clientRequestId, ...(revision ? { action: revision.action, messageId: revision.messageId, ...(revision.action === 'regenerate' ? { regenerateStyle: revision.regenerateStyle || 'retry' } : {}) } : {}) }), headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, signal });
        if (!r.ok) {
            const d: any = await r.json();
            throw new ApiError(d.error || '서버에 연결하지 못했습니다.', r.status);
        }
        await readChatStream(r, { signal, onEvent });
    }
    async function send(revision?: Revision) {
        const inputPrompt = revision?.prompt ?? prompt;
        const submissionModel = revision?.model || modelId;
        if (!inputPrompt.trim() || busy || pendingRecovery || !ready || uploading || (chatId && loadedChatId !== chatId && runningId.current !== chatId))
            return;
        setError('');
        followBottom.current = true;
        if (!revision && activeTool === 'image' && !capabilities.image) { setError('이미지 생성 서비스가 아직 연결되지 않았습니다. 프롬프트는 그대로 보관됩니다.'); return; }
        if (!revision && activeTool === 'video' && !capabilities.video) { setError('동영상 생성 서비스가 아직 연결되지 않았습니다. 프롬프트는 그대로 보관됩니다.'); return; }
        if (!revision && activeTool === 'research' && researchSources.web && !capabilities.webResearch) { setError('웹 리서치는 아직 연결되지 않았습니다. 소스에서 웹을 끄고 제공한 문서로 조사할 수 있습니다.'); return; }
        if (!boot.user) {
            rememberDraft();
            setError('메시지를 보내고 대화를 저장하려면 로그인해주세요. 작성한 내용은 그대로 보관됩니다.');
            return;
        }
        if (!revision && (activeTool === 'image' || activeTool === 'video')) { await generateMedia(activeTool); return; }
        const targets = view === 'compare' ? compared : [submissionModel];
        if (targets.some(id => !isFreeModel(id)) && (walletBalance === null || walletBalance <= 0)) {
            setError(walletBalance === null ? '크레딧 잔액을 확인하고 있습니다. 잠시 후 다시 시도해주세요.' : '이 모델은 유료 크레딧 충전 후 사용할 수 있습니다. Flash-Lite는 무료로 계속 이용할 수 있습니다.');
            return;
        }
        if (targets.some(id => !boot.providers[findModel(id)!.provider].configured)) {
            setError('Connect ' + [...new Set(targets.filter(id => !boot.providers[findModel(id)!.provider].configured).map(id => PROVIDERS[findModel(id)!.provider].name))].join(' and ') + ' in Settings to start a real AI response.');
            return;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        streamPath.current = pathname;
        setBusy(true);
        if (view === 'compare') {
            setResults(Object.fromEntries(targets.map(id => [id, { text: '', loading: true }])));
            await Promise.allSettled(targets.map(async (id) => { try {
                await stream(id, undefined, controller.signal, e => { if (abortRef.current !== controller) return; setResults(old => ({ ...old, [id]: { ...old[id], ...(e.type === 'delta' ? { text: old[id].text + e.text } : e.type === 'replace' ? { text: e.text } : e.type === 'start' ? { conversationId: e.conversationId } : e.type === 'done' ? { loading: false, usage: e.usage } : {}) } })); });
            }
            catch (e) {
                if (abortRef.current !== controller) return;
                setResults(old => ({ ...old, [id]: { ...old[id], loading: false, error: e instanceof Error && e.name === 'AbortError' ? '응답을 중지했습니다.' : e instanceof Error ? e.message : '요청을 처리하지 못했습니다.' } }));
            } }));
        }
        else {
            const userId = crypto.randomUUID(), assistantId = crypto.randomUUID(), clientRequestId = crypto.randomUUID();
            const previousMessages = messages;
            let persistedUserId = userId, persistedAssistantId = assistantId;
            const targetIndex = revision ? messages.findIndex(message => message.id === revision.messageId) : -1;
            const revisedUserIndex = revision?.action === 'regenerate' && messages[targetIndex]?.role === 'assistant' ? targetIndex - 1 : targetIndex;
            if (revision && (revisedUserIndex < 0 || messages[revisedUserIndex]?.role !== 'user')) { setBusy(false); abortRef.current = null; setError('수정할 메시지를 찾지 못했습니다. 대화를 다시 열어 주세요.'); return; }
            let started = false;
            let savedRequestId = '', savedConversationId = '', partialText = '';
            const requestEpoch = navigationEpoch.current;
            const submittedPrompt = inputPrompt;
            if (activeTool === 'chat' && !revision) setPrompt('');
            if (revision) setEditingMessage(null);
            pendingTurnMotion.current = {
                key: userId,
                composerRect: messages.length === 0 && !revision
                    ? inputRef.current?.closest('.gemini-compose-wrap')?.getBoundingClientRect() ?? null
                    : null,
            };
            setMessages(old => [...(revision ? old.slice(0, revisedUserIndex) : old), { id: userId, renderKey: userId, role: 'user', content: inputPrompt }, { id: assistantId, renderKey: assistantId, role: 'assistant', content: '', model: submissionModel, saved: false }]);
            try {
                await stream(submissionModel, chatId || runningId.current, controller.signal, e => {
                    if (abortRef.current !== controller) return;
                    if (e.type === 'start') {
                        started = true;
                        savedRequestId = e.requestId || ''; savedConversationId = e.conversationId;
                        if (typeof e.userMessageId === 'string') persistedUserId = e.userMessageId;
                        if (typeof e.assistantMessageId === 'string') persistedAssistantId = e.assistantMessageId;
                        runningId.current = e.conversationId;
                        setLoadedChatId(e.conversationId);
                        if (!chatId && typeof e.title === 'string') {
                            setChats(old => [{ id: e.conversationId, title: e.title, model: submissionModel, updated_at: e.createdAt }, ...old.filter(c => c.id !== e.conversationId)]);
                        }
                        try { localStorage.setItem('prism-tool:' + e.conversationId, e.tool || composerTool); } catch {}
                    }
                    if (e.type === 'replace') {
                        partialText = e.text;
                        setMessages(old => old.map(m => m.id === assistantId ? { ...m, content: e.text } : m));
                    }
                    if (e.type === 'delta') {
                        partialText += e.text;
                        setMessages(old => old.map(m => m.id === assistantId ? { ...m, content: m.content + e.text } : m));
                    }
                    if (e.type === 'done') {
                        setMessages(old => old.map(message => message.id === userId ? { ...message, id: e.userMessageId || persistedUserId, saved: true } : message.id === assistantId ? { ...message, id: e.assistantMessageId || persistedAssistantId, created_at: e.createdAt, feedback: null, saved: true } : message));
                        if (e.title) setChats(old => old.map(c => c.id === e.conversationId ? { ...c, title: e.title } : c));
                        if (!revision) { setPrompt(''); setAttached([]); }
                        if (!chatId)
                            navigate('/chat/' + e.conversationId, { replace: true });
                    }
                }, revision, clientRequestId);
            }
            catch (e) {
                if (abortRef.current !== controller) return;
                setError(e instanceof Error && e.name === 'AbortError' ? '응답을 중지했습니다. 이미 생성된 내용은 이용 한도에 포함될 수 있습니다.' : e instanceof Error ? e.message : '요청을 처리하지 못했습니다.');
                if (revision) {
                    setMessages(previousMessages);
                    if (revision.action === 'edit') setEditingMessage({ id: revision.messageId, content: submittedPrompt });
                }
                else if (!started) {
                    setPrompt(submittedPrompt);
                    setMessages(old => old.filter(m => m.id !== userId && m.id !== assistantId));
                }
                else {
                    // Keep the real partial answer visible when stopped or interrupted.
                    setMessages(old => old.filter(m => m.id !== assistantId || !!m.content.trim()).map(message => message.id === userId ? { ...message, id: persistedUserId, saved: true } : message));
                }
                // A disconnected reader can miss start/done even after the server
                // commits. Resolve by the retained idempotency key before retrying.
                if (started || !(e instanceof ApiError && e.status >= 400 && e.status < 500)) {
                    const recovery: PendingRecovery = { clientRequestId, requestId: savedRequestId || undefined, conversationId: savedConversationId || chatId || runningId.current, epoch: requestEpoch, revision,
                        partialAnswer: !revision && partialText.trim() ? { id: assistantId, role: 'assistant', content: partialText, model: submissionModel, saved: false } : undefined };
                    setPendingRecovery(recovery);
                    await reconcileResponse(recovery);
                }
            }
        }
        if (abortRef.current === controller) {
            setBusy(false);
            abortRef.current = null;
            void loadChats();
        }
        if (targets.some(id => !isFreeModel(id))) notifyBillingUpdated();
    }
    async function reconcileResponse(recovery: PendingRecovery) {
        const current = () => recovery.epoch === navigationEpoch.current;
        if (!current()) return;
        setRecovering(true);
        try {
            for (let attempt = 0; attempt < 5; attempt++) {
                let operation: any;
                try {
                    operation = await api('chat/operations/' + encodeURIComponent(recovery.requestId || recovery.clientRequestId) + (recovery.requestId ? '' : '?by=client'), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
                } catch (failure) {
                    // Before start arrives, the request may still be reaching the
                    // server. A missing record is not a successful generation.
                    if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
                }
                if (!current()) return;
                if (operation && (operation.status === 'complete' || operation.status === 'error')) {
                    const conversationId = operation.conversationId || recovery.conversationId;
                    let canonical: any;
                    try {
                        canonical = await api('conversations/' + encodeURIComponent(conversationId), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
                    } catch (failure) {
                        // Preparation can fail before a new conversation exists.
                        if (!(operation.status === 'error' && failure instanceof ApiError && failure.status === 404)) throw failure;
                        if (current()) setPendingRecovery(null);
                        return;
                    }
                    if (!current()) return;
                    const lastSaved = canonical.messages.at(-1);
                    const keepPartial = operation.status === 'error' && recovery.partialAnswer && lastSaved?.role === 'user' && lastSaved.id === operation.userMessageId;
                    setMessages(keepPartial ? [...canonical.messages, recovery.partialAnswer] : canonical.messages);
                    setLoadedChatId(conversationId); runningId.current = conversationId;
                    setChats(old => old.some(chat => chat.id === conversationId) ? old.map(chat => chat.id === conversationId ? { ...chat, ...canonical.conversation } : chat) : [canonical.conversation, ...old]);
                    setPendingRecovery(null);
                    if (operation.status === 'complete') { setEditingMessage(null); setError(''); setNotice('저장된 응답을 불러왔습니다.'); if (!recovery.revision) { setPrompt(''); setAttached([]); } }
                    else if (recovery.revision?.action === 'edit') setEditingMessage({ id: recovery.revision.messageId, content: recovery.revision.prompt });
                    if (!chatId) navigate('/chat/' + conversationId, { replace: true });
                    return;
                }
                if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 650));
            }
            if (current()) setError('응답의 저장 결과를 확인 중입니다. 잠시 후 저장 결과 확인을 눌러 주세요.');
        } catch { if (current()) setError('저장 결과를 확인하지 못했습니다. 연결이 복구되면 저장 결과 확인을 눌러 주세요.'); }
        finally { if (current()) setRecovering(false); }
    }
    async function generateMedia(kind:'image'|'video'|'music',description=prompt){
        if(busy||!description.trim())return;
        if(!boot.user){rememberDraft();setError('미디어를 생성하고 저장하려면 로그인해주세요.');return;}
        const controller=new AbortController();abortRef.current=controller;streamPath.current=pathname;setBusy(true);setError('');
        try{
            const result=await api('media',{...post({kind,prompt:description,aspect:videoAspect,referenceId:kind==='music'?undefined:mediaReference?.id}),signal:controller.signal});
            if(abortRef.current!==controller)return;
            setMediaAssets(current=>[result,...current.filter(asset=>asset.id!==result.id)]);
            if(kind!=='music')setPrompt('');
            setNotice(result.status==='processing'?'생성 요청이 접수되었습니다. 결과는 이 화면에 저장됩니다.':'생성한 파일을 저장했습니다.');
        }catch(cause){
            if(abortRef.current!==controller)return;
            setError(cause instanceof Error&&cause.name==='AbortError'?'결과 수신을 중지했습니다. 이미 접수된 요청은 이용 한도에 포함될 수 있습니다. 다시 생성하기 전에 저장된 결과를 확인해주세요.':cause instanceof Error?cause.message:'미디어를 생성하지 못했습니다.');
            loadMedia().catch(()=>{});
        }finally{if(abortRef.current===controller){setBusy(false);abortRef.current=null;}}
    }
    async function uploadReference(file:File){
        if(!boot.user){setError('참고 이미지를 업로드하려면 로그인해주세요.');return;}
        if(file.size>4*1024*1024||!['image/png','image/jpeg','image/webp'].includes(file.type)){setError('4 MB 이하의 PNG, JPEG, WebP 이미지를 선택해주세요.');return;}
        const epoch=navigationEpoch.current;
        setUploading(true);setError('');
        try{const body=new FormData();body.append('file',file);const result=await api('media/reference',{method:'POST',body});
            if(epoch!==navigationEpoch.current)return;
            const previous=mediaReference;setMediaReference(result);
            if(previous)api('media/'+previous.id,{method:'DELETE'}).catch(()=>{});
        }catch(cause){if(epoch===navigationEpoch.current)setError(cause instanceof Error?cause.message:'참고 이미지를 저장하지 못했습니다.');}
        finally{setUploading(false);if(mediaUploadRef.current)mediaUploadRef.current.value='';}
    }
    async function removeMediaReference(){
        if(!mediaReference||busy)return;
        const epoch=navigationEpoch.current;
        try{await api('media/'+mediaReference.id,{method:'DELETE'});if(epoch===navigationEpoch.current)setMediaReference(null);}
        catch(cause){if(epoch===navigationEpoch.current)setError(cause instanceof Error?cause.message:'참고 이미지를 제거하지 못했습니다.');}
    }
    async function upload(file: File, propagateError=false) { const epoch=navigationEpoch.current; setUploading(true); setError(''); try {
        const f = new FormData();
        f.append('file', file);
        const created = await api('files', { method: 'POST', body: f });
        await loadFiles();
        if (epoch !== navigationEpoch.current) return;
        setNotice('파일을 업로드했습니다. 대화에 첨부할 수 있습니다.');
        if (view === 'chat')
            setAttached(a => [...a, created.id].slice(-3));
    }
    catch (e) {
        if (epoch === navigationEpoch.current) setError((e as Error).message);
        if(propagateError)throw e;
    }
    finally {
        setUploading(false);
        if (uploadRef.current)
            uploadRef.current.value = '';
    } }
    function requestDelete(chat: { id: string; title: string }) {
        setDeleteError(''); setMobile(false);
        setDeleteTarget({ kind: 'conversations', ...chat });
    }
    function requestRename(chat: { id: string; title: string }) {
        setRenameError(''); setMobile(false); setRename({ id: chat.id, title: chat.title });
    }
    async function remove() {
      if (!deleteTarget || deleting) return;
      const target = deleteTarget;
      setDeleting(true); setDeleteError('');
      try {
        if (target.kind === 'conversations' && target.id === (chatId || runningId.current)) stopForNavigation();
        await api(target.kind + '/' + encodeURIComponent(target.id), { method: 'DELETE' });
        if (target.kind === 'files') {
            setAttached(a => a.filter(x => x !== target.id));
            await loadFiles();
        }
        else {
            chatsRequest.current++;
            setChats(current => current.filter(chat => chat.id !== target.id));
            const key = 'prism-canvas:v1:' + encodeURIComponent(boot.user?.email || 'guest') + ':' + target.id;
            setCanvasDrafts(current => { const next = { ...current }; delete next[key]; return next; });
            try { sessionStorage.removeItem(key); localStorage.removeItem('prism-tool:' + target.id); } catch {}
            if (currentPath.current === '/chat/' + target.id || runningId.current === target.id) resetChat(true);
            void loadChats();
        }
        setDeleteTarget(null);
        setNotice(target.kind === 'files' ? '파일을 삭제했습니다.' : '대화를 삭제했습니다.');
    }
    catch (e) {
        setDeleteError(e instanceof Error ? e.message : '삭제하지 못했습니다. 다시 시도해주세요.');
    } finally { setDeleting(false); } }
    function exportChat() { const blob = new Blob([messages.map(m => (m.role === 'user' ? 'You' : findModel(m.model || '')?.name || 'AI') + '\n\n' + m.content).join('\n\n────────────\n\n')], { type: 'text/plain' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'prism-conversation.txt'; a.click(); URL.revokeObjectURL(url); }
    async function togglePin(chat: { id: string; pinned_at?: number | null }) {
        if (pinRequests.current.has(chat.id)) return;
        pinRequests.current.add(chat.id);
        try {
            const pinned = !chat.pinned_at;
            await api('conversations/' + encodeURIComponent(chat.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned }) });
            setChats(current => current.map(item => item.id === chat.id ? { ...item, pinned_at: pinned ? Date.now() : null } : item).sort((a, b) => Number(!!b.pinned_at) - Number(!!a.pinned_at) || (b.pinned_at || b.updated_at) - (a.pinned_at || a.updated_at)));
            setNotice(pinned ? '대화를 고정했습니다.' : '대화 고정을 해제했습니다.');
            void loadChats();
        } catch (failure) { setError(failure instanceof Error ? failure.message : '대화 고정을 변경하지 못했습니다.'); }
        finally { pinRequests.current.delete(chat.id); }
    }
    async function downloadPdf(chat?: { id: string; title: string }) {
        if (pdfBusy || busy) return;
        setPdfBusy(true);
        try {
            const selectedMessages = chat && chat.id !== (chatId || runningId.current) ? (await api('conversations/' + encodeURIComponent(chat.id))).messages as Message[] : messages;
            const { downloadConversationPdf } = await import('../lib/print-conversation');
            await downloadConversationPdf({ title: chat?.title || chats.find(item => item.id === (chatId || runningId.current))?.title || 'Prism 대화', messages: selectedMessages.map(message => ({ ...message, content: message.role === 'user' ? message.prompt_text ?? message.content : message.content })) }, { renderedMessages: !chat || chat.id === (chatId || runningId.current) ? mainRef.current?.querySelector<HTMLElement>('.conversation-screen .messages') : null });
            setNotice('인쇄 창에서 ‘PDF로 저장’을 선택해 주세요.');
        } catch (failure) { setError(failure instanceof Error ? failure.message : 'PDF를 만들지 못했습니다.'); }
        finally { setPdfBusy(false); }
    }
    async function exportDocs(chat?: { id: string; title: string }) {
        try {
            const selectedMessages = chat && chat.id !== (chatId || runningId.current) ? (await api('conversations/' + encodeURIComponent(chat.id))).messages as Message[] : messages;
            const title = chat?.title || chats.find(item => item.id === (chatId || runningId.current))?.title || 'Prism 대화';
            setExportTarget({ kind: 'docs', title, content: conversationMarkdown(title, selectedMessages) });
        } catch (failure) { setError(failure instanceof Error ? failure.message : '내보낼 대화를 불러오지 못했습니다.'); }
    }
    async function rateResponse(message: Message, rating: 'up' | 'down' | null, details?: string) {
        const conversationId = chatId || runningId.current, epoch = navigationEpoch.current;
        if (!conversationId || message.saved === false) throw new Error('응답이 저장된 뒤 의견을 보낼 수 있습니다.');
        await api('conversations/' + encodeURIComponent(conversationId) + '/messages/' + encodeURIComponent(message.id) + '/feedback', post({ rating, ...(details !== undefined ? { details } : {}) }));
        if (epoch !== navigationEpoch.current) return;
        setMessages(current => current.map(item => item.id === message.id ? { ...item, feedback: rating } : item));
        setNotice(rating ? '의견을 보내 주셔서 감사합니다.' : '의견을 취소했습니다.');
    }
    function responseTarget(message: Message): DetailTarget { return { ...message, conversationId: message.saved === false ? undefined : chatId || runningId.current }; }
    function regenerate(message: Message, index: number, style: Revision['regenerateStyle'] = 'retry') {
        const question = messages[index - 1];
        if (!question || question.role !== 'user' || busy) return;
        return send({ action: 'regenerate', messageId: message.saved === false ? question.id : message.id, prompt: question.prompt_text ?? question.content, model: message.model, regenerateStyle: style });
    }
    const sectionTitle: Record<string, string> = { chat: 'New chat', compare: 'Compare models', models: 'Model library', history: 'Chat history', files: 'My files', usage: 'Usage', settings: 'Settings', billing: '충전 및 잔액', admin: 'Administration', privacy: 'Privacy', terms: 'Terms', faq: 'Help & FAQ' };
    function providerStatus(p: Provider) { return <span className={'connection ' + (boot.providers[p].configured ? 'online' : '')}><i />{boot.providers[p].configured ? 'Configured' : 'Not connected'}</span>; }
    function modelCard(m: Model, index: number) { return <button key={m.id} className={'model-card provider-' + m.provider + (selected.id === m.id ? ' chosen' : '')} onClick={() => { if (choose(m)) go('/chat'); }}><div className="card-top"><Mark provider={m.provider}/><span className={'tier ' + (m.tier === 'Advanced' ? 'premium' : '')}>{index === 0 && view === 'chat' ? <Sparkles size={11}/> : null}{m.tier}</span></div><h3>{m.name}</h3><p>{m.description}</p><div className="card-foot"><span>{m.category}</span><ArrowUpRight size={16}/></div></button>; }
    const signInHref='/signin-with-chatgpt?return_to='+encodeURIComponent(pathname);
    const errorBanner = error && <div className="error-banner" role="alert"><AlertCircle size={17}/><span>{error}</span>{error.includes('Connect') || error.includes('not connected') ? <button onClick={() => go('/settings')}>Open settings <ArrowRight size={13}/></button> : error.includes('크레딧') ? <a href="/upgrade" target="_blank" rel="noopener noreferrer">크레딧 충전</a> : !boot.user ? <a href={signInHref} target="_top" data-prism-auth-link onClick={rememberDraft}>로그인</a> : null}<button className="icon-button" aria-label="오류 닫기" onClick={() => setError('')}><X size={15}/></button></div>;
    const chatUnavailable = view === 'chat' && !!chatId && loadedChatId !== chatId && runningId.current !== chatId;
    const activeChatId = view === 'chat' ? chatId || runningId.current : undefined;
    const activeChat = activeChatId ? { id: activeChatId, title: chats.find(chat => chat.id === activeChatId)?.title || '내 대화', pinned_at: chats.find(chat => chat.id === activeChatId)?.pinned_at } : undefined;
    const inConversation = view === 'chat' && (!!chatId || messages.length > 0) && composerTool !== 'canvas';
    const composer = <><Composer
      prompt={prompt} onPrompt={setPrompt} inputRef={inputRef}
      models={availableModels} selected={selected} onModel={choose} providers={boot.providers}
      effort={effort} onEffort={setEffort} pro={pro} onPro={setPro} mode={workspaceMode} compare={view === 'compare'}
      tool={activeTool} onTool={selectTool}
      researchSources={researchSources} onResearchSources={setResearchSources}
      videoAspect={videoAspect} onVideoAspect={setVideoAspect} capabilities={capabilities} mediaModelLabel={activeTool==='image'?boot.mediaModels?.image:boot.mediaModels?.video}
      onDriveUpload={() => setDriveOpen(true)} onMusic={() => go('/music')}
      onMediaUpload={() => mediaUploadRef.current?.click()} mediaReference={mediaReference||undefined} onRemoveMediaReference={removeMediaReference}
      showCapabilityNotice={view !== 'images' && view !== 'videos'}
      busy={busy} ready={ready && !pendingRecovery} uploading={uploading} files={files} attached={attached}
      signedIn={!!boot.user} walletBalance={walletBalance} selectedSkill={selectedSkill} onSkill={setSelectedSkill}
      onAttach={id => setAttached(current => current.includes(id) ? current : [...current, id].slice(-3))}
      onDetach={id => setAttached(current => current.filter(value => value !== id))}
      onUpload={() => uploadRef.current?.click()} onSend={() => void send()}
      onStop={() => abortRef.current?.abort()} onNavigate={go} onError={setError}/>{ready&&!boot.user&&<p className="prism-signin-hint"><a href={signInHref} target="_top" data-prism-auth-link onClick={rememberDraft}>ChatGPT로 로그인</a>하고 메시지를 보내세요. 작성 중인 내용은 보관됩니다.</p>}</>;
    function resetChat(replace = false) {
      resetCopyFeedback();
      if ((walletBalance ?? 0) <= 0) { setModelId(DEFAULT_MODEL_ID); setEffort('minimal'); setPro(false); }
      navigationEpoch.current++;
      stopForNavigation();
      chatLoadController.current?.abort(); chatLoadController.current = null;
      setMobile(false);
      setMessages([]); setLoadedChatId(undefined); setChatLoadError(''); setError('');
      setPrompt(''); setAttached([]); setMediaReference(null); setSelectedSkill(null); runningId.current = undefined;
      setSearchOpen(false); setModelOpen(false); setHelp(false); setShareOpen(false);
      setEditingMessage(null); setExportTarget(null); setDetailTarget(null); setReportTarget(null);
      setPendingRecovery(null); setRecovering(false);
      if (!mutationPending.current) { setDeleteTarget(null); setRename(null); }
      setResults({});
      setComposerTool('chat'); setResearchSources({web:false});
      try { localStorage.setItem('prism-tool:draft','chat'); sessionStorage.removeItem('prism-signin-draft'); } catch {}
      navigate('/chat', { replace });
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    function newChat() { resetChat(); }
    async function createNotebook(file: File) {
      if (!boot.user) throw new Error('노트북을 저장하려면 로그인해주세요.');
      const epoch=navigationEpoch.current;
      const body = new FormData(); body.append('file', file);
      const created = await api('files', {method: 'POST', body});
      await loadFiles(); if(epoch!==navigationEpoch.current)return;
      setAttached([created.id]); setNotice('노트북을 저장하고 채팅에 첨부했습니다.');
      go('/chat');
    }
    function openShareDialog() {
      if (!boot.user || !chatId || busy || shareBusy || chatUnavailable) return;
      setShareOpen(true); setShareUrl(''); setShareError(''); setSharePreview(null); setSharePreviewLoading(true); setShareReviewed(false); setShareExpiry('7');
    }
    async function createShare() {
      if (!chatId || shareBusy || !shareReviewed || sharePreview?.conversationId !== chatId) return;
      const epoch = navigationEpoch.current;
      setShareBusy(true); setShareError('');
      try {
        const result = await api('shares', post({ conversationId: chatId, privacyConfirmed: true, previewHash: sharePreview.previewHash, expiresInDays: shareExpiry === 'never' ? null : Number(shareExpiry) }));
        if (epoch !== navigationEpoch.current) return;
        setShareUrl(new URL('/share/' + encodeURIComponent(result.token), window.location.origin).href); setShareExpiresAt(result.expires_at);
      }
      catch (failure) { if (epoch === navigationEpoch.current) { setShareError(failure instanceof Error ? failure.message : '공개 링크를 만들지 못했습니다.'); if (failure instanceof ApiError && failure.status === 409) setShareReviewed(false); } }
      finally { setShareBusy(false); }
    }
    async function saveCanvas(text: string) {
      if (!boot.user) throw new Error('Canvas 문서를 저장하려면 로그인해 주세요.');
      const epoch=navigationEpoch.current;
      const body = new FormData();
      body.append('file',new File([text],'Canvas-' + new Date().toISOString().slice(0,10) + '.md',{type:'text/markdown'}));
      const created = await api('files',{method:'POST',body});
      await loadFiles(); if(epoch!==navigationEpoch.current)return;
      setAttached(current => [...current.filter(id => id !== created.id),created.id].slice(-3));
      setNotice('Canvas를 파일에 저장하고 다음 메시지에 첨부했습니다.');
    }
    const secondaryView = ['personalization-settings', 'gemini-spark', 'browser-settings', 'customize', 'gems', 'import', 'sharing', 'share', 'feedback'].includes(view);
    return <div className={'app-shell gemini-shell ' + (mobile ? 'sidebar-open ' : '') + (collapsed ? 'sidebar-collapsed' : '')}>
 {exportTarget && <DeferredPanel label="대화 내보내기" dialog onClose={() => setExportTarget(null)}><ExportDialog target={exportTarget} onClose={() => setExportTarget(null)} signedIn={!!boot.user}/></DeferredPanel>}
 {detailTarget && <DeferredPanel label="응답 세부정보" dialog onClose={() => setDetailTarget(null)}><ResponseDetailsDialog target={detailTarget} onClose={() => setDetailTarget(null)}/></DeferredPanel>}
 {reportTarget && <DeferredPanel label="신고" dialog onClose={() => setReportTarget(null)}><LegalReportDialog target={reportTarget} onClose={() => setReportTarget(null)} signedIn={!!boot.user}/></DeferredPanel>}
 <BrowserLinkGuard signedIn={!!boot.user} remoteConfigured={capabilities.remoteBrowser} onNavigate={go}/>
 <input ref={mediaUploadRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event=>{const file=event.target.files?.[0];if(file)void uploadReference(file);}}/>
 <input ref={uploadRef} type="file" accept=".txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.html,.css,.xml,.yaml,.yml,.sql" hidden onChange={e => { const f = e.target.files?.[0]; if (f)
        upload(f); }}/>
 {mobile && <button className="sidebar-backdrop" aria-label="탐색 메뉴 닫기" onClick={() => setMobile(false)}/>}
 <aside ref={sidebarRef} className="sidebar gemini-sidebar" aria-label="주 탐색" role={mobile ? 'dialog' : undefined} aria-modal={mobile ? true : undefined}>
   <div className="gemini-brand-row"><a href="/chat" className="gemini-brand" aria-label="Prism 홈" onClick={event => { event.preventDefault(); newChat(); }}><PrismMark/><span>Prism</span></a><div className="sidebar-tools"><button type="button" aria-label="채팅 검색" onPointerEnter={() => { void loadSearch().catch(() => {}); }} onFocus={() => { void loadSearch().catch(() => {}); }} onClick={() => setSearchOpen(true)}><Search size={18}/></button><button type="button" aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'} onClick={() => { if (window.matchMedia('(max-width: 767px)').matches) setMobile(false); else setCollapsed(value => !value); }}>{collapsed ? <PanelLeftOpen size={17}/> : <PanelLeftClose size={17}/>}</button></div></div>
   <nav className="gemini-navigation">
     <button className="gemini-nav-item gemini-new-chat" onClick={newChat} title="새 채팅 (Ctrl+Shift+O)" aria-keyshortcuts="Control+Shift+O Meta+Shift+O"><PenLine size={19}/><span>새 채팅</span></button>
     {[{path:'/library',label:'라이브러리',icon:Grid2X2},{path:'/images',label:'이미지',icon:Image},{path:'/scheduled',label:'예약됨',icon:Clock3},{path:'/customize',label:'맞춤설정',icon:Hexagon},{path:'/videos',label:'동영상',icon:Video}].map(item => <button key={item.path} className={'gemini-nav-item ' + (pathname === item.path ? 'is-active' : '')} onPointerEnter={() => preloadWorkspaceView(item.path)} onFocus={() => preloadWorkspaceView(item.path)} onClick={() => go(item.path)} title={item.label}><item.icon size={19}/><span>{item.label}</span></button>)}
   </nav>
   <section className="gemini-notebooks"><h2>노트북</h2><button className="gemini-nav-item" onPointerEnter={() => preloadWorkspaceView('/notebooks/new')} onFocus={() => preloadWorkspaceView('/notebooks/new')} onClick={() => go('/notebooks/new')} title="새 노트북"><Plus size={21}/><span>새 노트북</span></button>{files.filter(file => file.name.endsWith('.md')).slice(0,3).map(file => <button key={file.id} className="gemini-nav-item gemini-notebook-item" onClick={() => { setAttached([file.id]); go('/chat'); setNotice('노트북을 첨부했습니다.'); }} title={file.name}><NotebookPen size={17}/><span>{file.name.replace(/\.md$/, '')}</span></button>)}</section>
   {!boot.user && <button className="gemini-activity" onClick={() => go('/settings')}><History size={21}/><span>Prism에 로그인하고 시작하세요<u>여기에서 로그인</u></span></button>}
   {(chats.length > 0 || chatsLoading || chatsError) && <section className="gemini-recent" aria-busy={chatsLoading}><h2>최근</h2>
     {chats.length === 0 && chatsLoading && <p className="prism-history-status" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true"/>대화 목록을 불러오는 중…</p>}
     {chatsError && <div className="prism-history-status prism-history-error"><span role="alert">대화 목록을 불러오지 못했습니다.</span><button type="button" onClick={() => { void loadChats(); }}>다시 시도</button></div>}{chats.slice(0,8).map(chat => <div key={chat.id} className={'prism-recent-row' + (activeChatId === chat.id ? ' is-active' : '')}><button type="button" className="prism-recent-link" aria-current={activeChatId === chat.id ? 'page' : undefined} onClick={() => go('/chat/' + chat.id)} title={chat.title}><span>{chat.title}</span>{!!chat.pinned_at && <Pin size={14} className="prism-pin-indicator" aria-label="고정된 대화"/>}</button><ConversationActions title={chat.title} onRename={() => requestRename(chat)} onDelete={() => requestDelete(chat)} onPin={() => togglePin(chat)} isPinned={!!chat.pinned_at} onDownloadPdf={() => downloadPdf(chat)} onExportDocs={() => exportDocs(chat)} exportBusy={pdfBusy || busy} /></div>)}</section>}
   <div className="gemini-account-row"><AccountPopover user={boot.user} beta={boot.beta} walletBalance={walletBalance} pathname={pathname} signInHref={signInHref} onSignIn={rememberDraft} onNavigate={go}/><SettingsMenu onNavigate={go} onHelp={() => setHelp(true)} signedIn={!!boot.user} beta={boot.beta} triggerClassName="gemini-settings-trigger"/></div>
 </aside>
 <div className="main-shell gemini-workspace" data-welcome-phase={welcomePhase} data-glow={view === 'chat' && !chatId && messages.length === 0 && composerTool !== 'video'}><WorkspaceHeader onMenu={() => { if (window.matchMedia('(max-width: 767px)').matches) setMobile(true); else setCollapsed(false); }} onNew={newChat} onNotice={setNotice} showNavigation={collapsed} inConversation={inConversation}
   conversation={activeChat} onRename={() => { if (activeChat) requestRename(activeChat); }} onDelete={() => { if (activeChat) requestDelete(activeChat); }}
   onPin={() => { if (activeChat) return togglePin(activeChat); }} isPinned={!!activeChat?.pinned_at}
   onShare={boot.user && chatId && !chatUnavailable ? openShareDialog : undefined} shareDisabled={busy || shareBusy}
   onDownloadPdf={() => downloadPdf(activeChat)} onExportDocs={() => exportDocs(activeChat)} exportBusy={pdfBusy || busy || chatUnavailable}/>

 <main ref={mainRef} className={'main-content gemini-main view-' + view} onScroll={event => { const target = event.currentTarget; followBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 120; }}>{errorBanner}<DeferredPanel resetKey={pathname}>
 {pendingRecovery && <div className="prism-recovery-banner" role="status"><span>{recovering ? '저장 결과를 확인하고 있습니다…' : '응답의 저장 상태를 확인한 뒤 이어서 대화할 수 있습니다.'}</span><button type="button" disabled={recovering} onClick={() => void reconcileResponse(pendingRecovery)}>{recovering && <LoaderCircle size={15} className="spin"/>}저장 결과 확인</button></div>}
 {ready && boot.user && view === 'chat' && !chatId && <GuestImportNotice onImported={id => { rememberDraft(); void loadChats(); go('/chat/' + id); setNotice('로그인 전 대화를 저장했습니다.'); }} />}
 {['history','files','models','compare'].includes(view) && <nav className="prism-library-nav" aria-label="라이브러리 종류">{[{path:'/history',label:'채팅'},{path:'/files',label:'파일 및 노트북'},{path:'/models',label:'AI 모델'},...(!boot.beta?[{path:'/compare',label:'모델 비교'}]:[])].map(item => <button key={item.path} onClick={() => go(item.path)} aria-current={view === item.path.slice(1) ? 'page' : undefined}>{item.label}</button>)}</nav>}
 {view === 'chat' && (chatUnavailable ? <section className="prism-chat-loading" aria-busy={!chatLoadError}>{chatLoadError ? <div className="prism-chat-load-error"><AlertCircle size={28}/><h1>대화를 불러오지 못했습니다</h1><p role="alert">{chatLoadError}</p><div><button type="button" className="secondary-button" onClick={() => { setChatLoadError(''); setChatRetry(value => value + 1); }}><RefreshCw size={16}/>다시 시도</button><button type="button" className="primary-button" onClick={newChat}>새 채팅</button></div></div> : <><span className="sr-only" role="status">대화를 불러오는 중입니다.</span><div className="prism-chat-skeleton" aria-hidden="true"><div className="prism-chat-skeleton-prompt"/><div className="prism-chat-skeleton-answer"><div><i/><i/><i/><i/></div></div></div></>}</section> : !chatId && messages.length === 0 ? <div className="gemini-welcome"><div className="gemini-welcome-inner"><h1>{workspaceMode === 'chat' ? '무엇을 도와드릴까요?' : '어떤 작업을 도와드릴까요?'}</h1>{composer}{activeTool === 'chat' && <div className="gemini-mode-switch" role="group" aria-label="작업 모드"><button type="button" aria-pressed={workspaceMode === 'chat'} className={workspaceMode === 'chat' ? 'selected' : ''} onClick={() => setWorkspaceMode('chat')}>채팅</button><button type="button" aria-pressed={workspaceMode === 'work'} className={workspaceMode === 'work' ? 'selected' : ''} onClick={() => setWorkspaceMode('work')}>작업</button></div>}</div></div> : <div className={composerTool === 'canvas' ? 'prism-canvas-layout' : 'prism-conversation-layout'}><div className={'conversation-screen' + (inConversation ? ' prism-thread' : '')}>{!inConversation && <div className="chat-toolbar"><span><MessageSquare size={15}/> {chats.find(c => c.id === chatId)?.title || '내 대화'}</span><div className="prism-chat-actions">{chatId && <button disabled={busy || shareBusy} onClick={openShareDialog}><Share2 size={15}/>공유</button>}<button onClick={exportChat}><Download size={14}/>내보내기</button></div></div>}<div className="messages">{messages.map((m, index) => <div key={m.renderKey ?? m.id} className={'message ' + m.role + (editingMessage?.id === m.id ? ' is-editing' : '')} data-message-id={m.id} data-arriving={m.renderKey ? 'true' : undefined} data-streaming={m.role === 'assistant' && busy && index === messages.length - 1 ? 'true' : undefined}>
   <div className="message-body"><h4 className="sr-only">{m.role === 'user' ? '내 메시지' : 'Prism의 응답'}</h4>
   {m.role === 'user' && editingMessage?.id === m.id ? <form className="prism-prompt-editor" onSubmit={event => { event.preventDefault(); if (editingMessage.content.trim()) void send({ action: 'edit', messageId: m.id, prompt: editingMessage.content }); }}>
     <textarea aria-label="프롬프트 수정" autoFocus maxLength={32000} disabled={busy} value={editingMessage.content} onChange={event => setEditingMessage({ id: m.id, content: event.target.value })}/>
     {index < messages.length - 2 && <p className="prism-prompt-editor-note">수정한 메시지부터 새 응답을 생성합니다.</p>}
     <div className="prism-prompt-editor-actions"><button type="button" disabled={busy} onClick={() => setEditingMessage(null)}>취소</button><button type="submit" disabled={busy || !!pendingRecovery || !editingMessage.content.trim()}>업데이트</button></div>
   </form> : m.content ? (m.role === 'assistant' ? <GuestMarkdown text={m.content}/> : <div tabIndex={0} aria-label="내 프롬프트" className="prism-prompt-focus" onPointerUp={event => { if (!(event.target as HTMLElement).closest('button')) event.currentTarget.focus({ preventScroll: true }); }}><CollapsiblePrompt text={m.prompt_text ?? m.content}/></div>) : <ThinkingIndicator/>}
   {m.content && m.role === 'user' && editingMessage?.id !== m.id && <div className="prism-user-actions">
     <button type="button" className="message-copy" data-copied={isCopied(m.id, m.prompt_text ?? m.content)} aria-label={isCopied(m.id, m.prompt_text ?? m.content) ? '프롬프트 복사됨' : '프롬프트 복사'} title={isCopied(m.id, m.prompt_text ?? m.content) ? '복사됨' : '프롬프트 복사'} onClick={() => void copy(m.id, m.prompt_text ?? m.content, '프롬프트가 복사되었습니다.')}>{isCopied(m.id, m.prompt_text ?? m.content) ? <Check size={16}/> : <Copy size={16}/>}</button>
     <button type="button" className="prism-user-edit" disabled={busy || !!pendingRecovery} aria-label="프롬프트 수정" title="수정" onClick={() => setEditingMessage({ id: m.id, content: m.prompt_text ?? m.content })}><PenLine size={16}/></button>
   </div>}
   {m.role === 'assistant' && m.content && !(busy && index === messages.length - 1) && <ResponseActions messageId={m.id} content={m.content} scope={pathname} copied={isCopied(m.id, m.content)} feedback={m.feedback} isLatest={index === messages.length - 1} regenerateDisabled={busy || !!pendingRecovery}
     onCopy={() => copy(m.id, m.content)} onFeedback={(value, details) => rateResponse(m, value, details)} onRegenerate={style => regenerate(m, index, style)}
     onExportDocs={() => setExportTarget({ kind: 'docs', title: activeChat?.title || 'Prism 응답', content: m.content })}
     onCreateGmailDraft={() => setExportTarget({ kind: 'gmail', title: activeChat?.title || 'Prism 응답', content: m.content })}
     onReportLegalIssue={() => setReportTarget(responseTarget(m))} onViewDetails={() => setDetailTarget(responseTarget(m))} onError={setError}/>}
   </div></div>)}<div ref={endRef}/></div><div className="chat-composer">{composer}{inConversation && <p className="prism-thread-footer">Prism은 AI이며 실수를 할 수 있습니다.</p>}</div></div>{composerTool === 'canvas' && <DeferredPanel label="Canvas" resetKey={canvasKey}><CanvasPanel key={canvasKey} draft={canvasDrafts[canvasKey]} onDraftChange={updateCanvasDraft} text={[...messages].reverse().find(message => message.role === 'assistant')?.content || ''} busy={busy} onRevise={reviseCanvas} onSave={saveCanvas} onError={setError}/></DeferredPanel>}</div>)}
 {view === 'compare' && !boot.beta && <div className="page-inner"><div className="page-heading"><span className="eyebrow">MORE PERSPECTIVES. BETTER DECISIONS.</span><h1>One question. Different minds.</h1><p>Send the same prompt to your models and compare real responses side by side.</p></div><div className="compare-selectors">{compared.map((id, i) => <div key={i} className="compare-select"><Mark provider={findModel(id)!.provider} size="small"/><select aria-label={'Comparison model ' + (i + 1)} disabled={busy} value={id} onChange={e => { if (compared.includes(e.target.value)) {
        setNotice('Choose a different model for each panel.');
        return;
    } setCompared(x => x.map((v, n) => n === i ? e.target.value : v)); setResults({}); }}>{availableModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>{compared.length > 2 && <button aria-label="Remove comparison panel" className="icon-button" onClick={() => setCompared(x => x.filter((_, n) => n !== i))}><X size={14}/></button>}</div>)}{compared.length < 3 && <button className="add-model" disabled={busy} onClick={() => { setCompared(x => [...x, MODELS.find(m => !x.includes(m.id))!.id]); setResults({}); }}><Plus size={15}/>Add model</button>}</div><div className="compare-grid" style={{ gridTemplateColumns: 'repeat(' + compared.length + ', minmax(0,1fr))' }}>{compared.map(id => <article key={id} className="compare-panel"><div className="compare-panel-head"><strong>{findModel(id)!.name}</strong>{providerStatus(findModel(id)!.provider)}</div>{results[id]?.text ? <div className="comparison-answer"><TextResponse text={results[id].text}/><button type="button" className="text-button" data-copied={isCopied('compare-' + id, results[id].text)} aria-label={isCopied('compare-' + id, results[id].text) ? '응답 복사됨' : '응답 복사'} onClick={() => void copy('compare-' + id, results[id].text)}>{isCopied('compare-' + id, results[id].text) ? <Check size={13}/> : <Copy size={13}/>}{isCopied('compare-' + id, results[id].text) ? '복사됨' : 'Copy response'}</button></div> : <div className="compare-empty"><Mark provider={findModel(id)!.provider}/><h3>A different perspective</h3><p>{findModel(id)!.category}<br />The response will appear here.</p></div>}{results[id]?.loading && <p className="panel-state"><LoaderCircle className="spin" size={14}/>Working on your prompt…</p>}{results[id]?.error && <p className="panel-error" role="alert">{results[id].error}</p>}{results[id]?.usage && <div className="panel-state"><CheckCircle2 size={13}/>{number(results[id].usage!.input + results[id].usage!.output)} tokens <button onClick={() => go('/chat/' + results[id].conversationId)}>Open chat <ArrowUpRight size={12}/></button></div>}</article>)}</div>{composer}<p className="fine-print">Each comparison sends a separate API request to each selected provider and incurs its API usage charges.</p></div>}
 {view === 'compare' && boot.beta && <div className="page-inner"><h1>More models are coming</h1><p>Choose a connected model in Chat. Comparison is not included in the limited trial.</p></div>}{view === 'models' && <div className="page-inner"><div className="page-heading"><span className="eyebrow">MEET YOUR NEXT THINKING PARTNER</span><h1>Many minds. One workspace.</h1><p>Explore models by what you want to do. Choose one and make it your own.</p></div><div className="filter-bar"><div className="filter-tabs">{['all', 'openai', 'anthropic', 'google'].map(p => <button className={filter === p ? 'selected' : ''} key={p} onClick={() => setFilter(p)}>{p === 'all' ? 'All models' : PROVIDERS[p as Provider].name}</button>)}</div><div className="search-input"><Search size={15}/><input aria-label="Search models" placeholder="Search models…" value={search} onChange={e => setSearch(e.target.value)}/></div></div><div className="model-grid library-grid">{availableModels.filter(m => (filter === 'all' || m.provider === filter) && (m.name + ' ' + m.category).toLowerCase().includes(search.toLowerCase())).map(modelCard)}</div>{availableModels.filter(m => (filter === 'all' || m.provider === filter) && (m.name + ' ' + m.category).toLowerCase().includes(search.toLowerCase())).length === 0 && <Empty icon={<Search />} title="No matching models" text="Try another name or provider."/>}<div className="info-panel"><ShieldCheck size={19}/><div><strong>Real API models, clearly labeled.</strong><p>Availability depends on your provider account. Pro and Extra High are reasoning settings on supported GPT models. Subscription-only modes such as Gemini Deep Think are not offered here without verified API access.</p><div className="source-links">{Object.entries(PROVIDERS).map(([p, v]) => <a key={p} href={MODELS.find(m => m.provider === p)!.source} target="_blank" rel="noreferrer">{v.name} model docs <ExternalLink size={12}/></a>)}</div></div></div></div>}
 {view === 'history' && <div className="page-inner"><div className="page-heading row-heading"><div><span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h1>Your conversations</h1><p>Good ideas are worth coming back to.</p></div><button className="primary-button" onClick={() => go('/chat')}><Plus size={15}/>New conversation</button></div><div className="search-input wide-search"><Search size={17}/><input autoFocus placeholder="Search your conversations…" aria-label="Search conversations" value={search} onChange={e => setSearch(e.target.value)}/><kbd>⌘ K</kbd></div>{chats.length === 0 && chatsLoading ? <p className="prism-history-status" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true"/>대화 목록을 불러오는 중…</p> : chats.length === 0 && chatsError ? <div className="prism-chat-load-error"><h2>대화 목록을 불러오지 못했습니다</h2><p role="alert">{chatsError}</p><button type="button" className="secondary-button" onClick={() => { void loadChats(); }}><RefreshCw size={14}/>다시 시도</button></div> : chats.length === 0 ? <Empty icon={<MessageSquare />} title="A blank page, full of possibility." text="Start a conversation. Your chats will be saved here automatically." action={<button className="primary-button" onClick={() => go('/chat')}>Start a conversation <ArrowRight size={14}/></button>}/> : <div className="history-list">{chats.filter(c => c.title.toLowerCase().includes(search.toLowerCase())).map(c => <div className="history-row" key={c.id}><button className="history-chat" onClick={() => go('/chat/' + c.id)}><Mark provider={findModel(c.model)?.provider || 'openai'} size="small"/><span><strong>{c.title}</strong><small>{findModel(c.model)?.name || c.model} <span>·</span> {new Date(c.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: historyTimeZone })}</small></span></button><button className="icon-button" aria-label={'Rename ' + c.title} onClick={() => requestRename(c)}><PenLine size={15}/></button><button className="icon-button danger-hover" aria-label={'Delete ' + c.title} onClick={() => requestDelete(c)}><Trash2 size={15}/></button></div>)}{!chats.some(c => c.title.toLowerCase().includes(search.toLowerCase())) && <Empty icon={<Search />} title="No conversations found" text="Try a different search."/>}</div>}</div>}
 {view === 'files' && <div className="page-inner"><div className="page-heading row-heading"><div><span className="eyebrow">GIVE YOUR IDEAS SOME CONTEXT</span><h1>A home for your documents.</h1><p>Upload text and code, then bring them into any conversation.</p></div><button disabled={uploading} className="primary-button" onClick={() => uploadRef.current?.click()}>{uploading ? <LoaderCircle className="spin" size={16}/> : <Plus size={16}/>}Upload file</button></div><button className="drop-zone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file)
        upload(file); }} onClick={() => uploadRef.current?.click()}><span><FolderOpen size={28}/></span><strong>{uploading ? 'Uploading your document…' : 'Drop a little context here'}</strong><p>Drag a file, or click to browse</p><small>TXT, Markdown, CSV, JSON, and source code · Up to 128 KB · 100 files</small></button><div className="section-heading"><h2>Your files <span className="count-label">{files.length}</span></h2></div>{files.length ? <div className="history-list">{files.map(f => <div key={f.id} className="history-row"><span className="file-icon"><FileText size={20}/></span><div className="file-details"><strong>{f.name}</strong><small>{(f.size / 1024).toFixed(1)} KB · {new Date(f.created_at).toLocaleDateString()}</small></div><button className="text-button" onClick={() => { setAttached([f.id]); go('/chat'); setNotice('Document attached. Ask a question about it.'); }}>Use in chat <ArrowUpRight size={13}/></button><a className="icon-button" aria-label={'Download ' + f.name} href={'/api/files/' + f.id} download={f.name}><Download size={15}/></a><button className="icon-button danger-hover" aria-label={'Delete ' + f.name} onClick={() => { setDeleteError(''); setDeleteTarget({ kind: 'files', id: f.id, title: f.name }); }}><Trash2 size={15}/></button></div>)}</div> : <p className="empty-line">No documents yet. Your first upload will appear here.</p>}<p className="fine-print">Attached document text is sent to the provider you select. PDF and image parsing are not enabled in this release.</p></div>}
 {view === 'usage' && <div className="page-inner"><div className="page-heading row-heading"><div><span className="eyebrow">EVERY TOKEN, ACCOUNTED FOR</span><h1>A clear view of your usage.</h1><p>Actual provider token counts from your completed requests.</p></div><button className="secondary-button" onClick={() => api('usage').then(setUsage).catch(e => setError(e.message))}><RefreshCw size={14}/>Refresh</button></div><div className="stats-grid">{[{ label: 'Total requests', value: usage?.totals?.requests || 0, icon: MessageSquare, caption: 'All-time API requests' }, { label: 'Input tokens', value: usage?.totals?.input_tokens || 0, icon: ArrowUpRight, caption: 'Reported by your providers' }, { label: 'Output tokens', value: usage?.totals?.output_tokens || 0, icon: Sparkles, caption: 'Includes provider-reported reasoning' }].map(s => <div key={s.label} className="stat-card"><div>{s.label}<s.icon size={17}/></div><strong>{number(s.value)}</strong><small>{s.caption}</small></div>)}</div><section className="data-panel"><div className="section-heading"><h2>Usage by provider</h2><span>All time</span></div>{usage?.byProvider?.length ? usage.byProvider.map((p: any) => { const total = usage.byProvider.reduce((n: number, p: any) => n + p.input_tokens + p.output_tokens, 0) || 1; return <div key={p.provider} className="provider-usage"><Mark provider={p.provider} size="small"/><span>{PROVIDERS[p.provider as Provider].name}</span><div><i style={{ width: ((p.input_tokens + p.output_tokens) / total * 100) + '%' }}/></div><strong>{number(p.input_tokens + p.output_tokens)} tokens</strong></div>; }) : <Empty icon={<ChartNoAxesCombined />} title="Your story starts with a question." text="Send your first message to see real usage here."/>}</section><section className="data-panel"><div className="section-heading"><h2>Recent requests</h2><span>Last 50</span></div><div className="table-scroll"><table><thead><tr><th>Model</th><th>Tokens in / out</th><th>Duration</th><th>Status</th><th>Date</th></tr></thead><tbody>{usage?.recent?.map((r: any) => <tr key={r.id}><td>{findModel(r.model)?.name || r.model}</td><td>{number(r.input_tokens)} / {number(r.output_tokens)}</td><td>{r.status === 'pending' ? '—' : (r.duration / 1000).toFixed(1) + 's'}</td><td><span title={r.error || ''} className={'request-status ' + r.status}>{r.status}</span></td><td>{new Date(r.created_at).toLocaleDateString()}</td></tr>)}</tbody></table>{!usage?.recent?.length && <p className="empty-line">No API requests yet.</p>}</div></section><p className="fine-print">Provider invoices are authoritative. Token counts for interrupted or failed requests may be unavailable even when the provider charges for partial generation.</p></div>}
 {view === 'settings' && <div className="page-inner settings-page"><div className="page-heading"><span className="eyebrow">MAKE YOURSELF AT HOME</span><h1>Your workspace, your way.</h1><p>Manage your account and the AI providers that power your conversations.</p></div><section className="data-panel account-panel"><div className="section-heading"><h2>Personal account</h2><ShieldCheck size={16}/></div><div className="account-detail"><span className="avatar large">{boot.user?.name?.slice(0, 2).toUpperCase() || 'P'}</span><div><strong>{boot.user?.name || 'Welcome to Prism'}</strong><p>{boot.user?.email || 'Sign in with ChatGPT to save conversations across devices.'}</p></div>{boot.user ? <a className="secondary-button" href="/signout-with-chatgpt?return_to=%2F" target="_top"><LogOut size={14}/>Sign out</a> : <a className="primary-button" href="/signin-with-chatgpt?return_to=%2Fsettings" onClick={rememberDraft} target="_top">Sign in with ChatGPT <ArrowUpRight size={14}/></a>}</div></section><div className="section-heading provider-heading"><div><h2>AI connections</h2><p>Keys are configured as server secrets and never sent to the browser.</p></div><span className="count-label">{connected} of 3</span></div>{(Object.entries(PROVIDERS) as [
        Provider,
        typeof PROVIDERS[Provider]
    ][]).map(([p, v]) => <section className="provider-setting" key={p}><div className="provider-setting-top"><Mark provider={p}/><div><h3>{v.name}</h3><p>{v.description}</p></div>{providerStatus(p)}</div><div className="provider-secret"><code>{v.secret}</code><span>{boot.providers[p].configured ? 'Server secret is configured' : 'Add this server secret to enable live responses'}</span><a href={v.url} target="_blank" rel="noreferrer">Provider console <ArrowUpRight size={13}/></a></div></section>)}<div className="info-panel"><ShieldCheck size={20}/><div><strong>API access is separate from chat subscriptions.</strong><p>Prism connects directly to provider APIs. A ChatGPT, Claude, or Gemini consumer subscription does not supply API credits. Each provider needs an API account, an enabled model, and sufficient quota. Providers may charge for requests.</p><button className="text-button" onClick={() => go('/billing')}>View API billing information <ArrowRight size={13}/></button></div></div>{workspaceDeletion&&<p role="status">{workspaceDeletion.message}</p>}<div className="settings-links">{boot.user&&<button className="danger-hover" disabled={workspaceDeleting||busy||uploading} onClick={()=>void eraseWorkspaceData()}>{workspaceDeleting?'삭제 중…':workspaceDeletion?.status==='pending'?'삭제 계속하기':'대화·파일 전체 삭제'}</button>}<button onClick={() => go('/privacy')}>Privacy</button><button onClick={() => go('/terms')}>Terms</button><button onClick={() => go('/faq')}>Help & FAQ</button>{boot.isAdmin && <button onClick={() => go('/admin')}>Administration</button>}</div></div>}
 {view === 'billing' && <BillingPanel beta={boot.beta} />}
 {view === 'admin' && boot.isAdmin && <BillingPanel admin/>}
 {view === 'admin' && <div className="page-inner"><div className="page-heading"><span className="eyebrow">PLATFORM OPERATIONS</span><h1>Administration</h1><p>Restricted server-side to the configured administrator account.</p></div>{admin ? <><div className="stats-grid">{['requests', 'users', 'tokens'].map(k => <div className="stat-card" key={k}><div>{k}</div><strong>{number(admin.totals?.[k])}</strong></div>)}</div><section className="data-panel"><div className="section-heading"><h2>보안 알림</h2><button className="text-button" onClick={()=>api('admin').then(setAdmin).catch(e=>setError(e.message))}>새로고침</button></div><p>반복된 인증 실패, 접근 거부, 요청 제한, 업로드 오류와 결제 이상을 확인합니다.</p>{admin.security?.alerts?.length?<div className="table-scroll"><table><thead><tr><th>종류</th><th>경로</th><th>횟수</th><th>심각도</th><th>상태</th></tr></thead><tbody>{admin.security.alerts.map((alert:any)=><tr key={alert.id}><td>{({authentication_failed:'인증 실패',access_denied:'접근 거부',rate_limit:'요청 제한',upload_rejected:'업로드 거부',payment_anomaly:'결제 이상',server_error:'서버 오류',runner_failure:'예약 실행 실패',slow_request:'지연된 요청',resource_spike:'급증한 AI 요청',deletion_retry:'삭제 재시도',admin_adjustment:'관리자 정산'} as Record<string,string>)[alert.category]||alert.category}</td><td>{alert.route}</td><td>{number(alert.event_count)}</td><td>{alert.severity==='high'?'높음':'주의'}</td><td>{alert.state==='acknowledged'?'확인됨':<button className="text-button" onClick={async()=>{try{await api('admin/security',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:alert.id})});setAdmin(await api('admin'));}catch(e){setError((e as Error).message);}}}>확인</button>}</td></tr>)}</tbody></table></div>:<p>현재 저장된 보안 알림이 없습니다.</p>}</section><section className="data-panel"><h2>Recent provider operations</h2><div className="table-scroll"><table><thead><tr><th>Model</th><th>Status</th><th>Error</th></tr></thead><tbody>{admin.logs.map((l: any, i: number) => <tr key={i}><td>{l.model}</td><td>{l.status}</td><td>{l.error || '—'}{l.status === 'error' && <button className="text-button" onClick={async () => { const input = window.prompt('제공사에서 확인한 입력 토큰 수'); if (input === null)
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
 {['privacy', 'terms', 'faq'].includes(view) && <div className="page-inner legal"><div className="page-heading"><span className="eyebrow">A LITTLE CLARITY</span><h1>{view === 'privacy' ? 'Your data in Prism.' : view === 'terms' ? 'How this workspace works.' : 'A few helpful answers.'}</h1><p>Release information · November 7, 2026</p></div>{(view === 'privacy' ? [['What is stored?', 'Your authenticated account ID, conversations, uploaded files, provider-reported usage, orders, purchase-consent snapshots, and wallet transactions are stored for the service and accounting. Card authentication is handled by Toss Payments and the payment provider; Prism does not collect card numbers or card passwords. Provider secret keys remain on the server.'], ['Where do prompts go?', 'When you send a message, your conversation context and selected attachments are transmitted to the provider you select. Comparison sends the prompt to every selected provider. Each provider’s own data processing terms apply.'], ['How can I delete my data?', 'Delete conversations from Chat history and documents from My files. Usage records remain for operational accounting and enforcing beta limits. Use Settings to delete all conversations and uploaded files. Avoid entering sensitive personal information. This does not delete your ChatGPT account. Accounting records remain for reconciliation; their retention and deletion policy must be finalized before commercial launch. Customer support is not configured yet.'], ['Deployment access', 'The site can be visited publicly. Limited text chat is available before sign-in. ChatGPT sign-in is required for saved conversations, files and account settings. Guest transcripts are imported only after explicit consent; data access is checked by account ID on the server.']] : view === 'terms' ? [['Independent API workspace', 'Prism is an independent interface to third-party AI APIs. It is not ChatGPT, Claude, or the Gemini consumer app and does not transfer a consumer subscription or its benefits.'], ['Model access and usage', 'Models are available only when the configured API account has access and sufficient quota. Responses can be inaccurate. You are responsible for checking results and for using providers in accordance with their applicable terms.'], ['Charges and limits', 'Requests consume the configured provider’s API quota and may incur fees, including interrupted responses. Comparison makes a separate billable request for each selected model. Prism is being prepared for prepaid credit purchases of KRW 10,000, 30,000, or 50,000. No subscription renewals are used. Sales remain disabled until pricing, refunds, seller information, and merchant setup are complete.'], ['Before a public launch', 'Operator: 종합상사 루비; representative: 노휘석. Registration number, address, customer support, deduction rates, refund terms and credit validity are pending. Commercial sales are disabled. The free beta has server-enforced allowances and no customer payments.']] : [['Do I need ChatGPT Plus or Pro?', 'Prism uses API access, which is separate from ChatGPT subscriptions. You can try limited text chat before sign-in. ChatGPT sign-in is required to save conversations and use the full workspace. The provider API account supplies model access and quota.'], ['How do I choose a model?', 'Open the model selector below your message, or explore the Model library. The model label is the actual configured API model. You can change models within a conversation.'], ['What do Pro and Extra High do?', 'For supported OpenAI models, Pro selects the API reasoning mode and Extra High selects reasoning effort. They can increase latency and API usage. They do not reproduce every feature of a ChatGPT subscription.'], ['Can I compare answers?', 'Yes. Select two or three different models in Compare models, then send one prompt. Each real response is shown independently. Provider connections are required.'], ['Which files can I upload?', 'Plain text, Markdown, CSV, JSON, and supported source code files up to 128 KB. Attach up to three files per message. PDF and image processing are not enabled.'], ['Why does a provider say Not connected?', 'The matching API key has not been configured as a server secret. Settings shows the required secret names and provider console links. No synthetic AI replies are generated.']]).map(([title, text]) => <section className="legal-section" key={title}><h2>{title}</h2><p>{text}</p></section>)}</div>}
 {view === 'auth' && <div className="page-inner"><Empty icon={<ShieldCheck />} title="A workspace for your best ideas." text="Sign in with ChatGPT to save your conversations, compare models, and keep your documents together." action={<a className="primary-button" href="/signin-with-chatgpt?return_to=%2Fchat" onClick={rememberDraft} target="_top">Continue with ChatGPT <ArrowUpRight size={15}/></a>}/><p className="fine-print">Authentication is managed by ChatGPT. Account creation and password recovery are handled there.</p></div>}
 {!secondaryView && !['chat', 'compare', 'models', 'history', 'files', 'usage', 'settings', 'billing', 'admin', 'privacy', 'terms', 'faq', 'auth', 'images', 'videos', 'music', 'scheduled', 'notebooks', 'browser'].includes(view) && <Empty icon={<Search />} title="This page wandered off." text="Head back to your workspace to start again." action={<button className="primary-button" onClick={() => go('/chat')}>Back to workspace</button>}/>}
 {(view === 'images' || view === 'videos') && <MediaWorkspace key={view} kind={view === 'videos' ? 'video' : 'image'} composer={composer} onNavigate={go} onFocus={() => inputRef.current?.focus()} configured={view==='videos'?capabilities.video:capabilities.image} busy={busy||mediaAssets.some(asset=>asset.kind===(view==='videos'?'video':'image')&&asset.status==='processing')} results={mediaAssets.filter(asset=>asset.kind===(view==='videos'?'video':'image')&&asset.status==='complete')} />}
 {secondaryView && <SettingsPages pathname={pathname} signedIn={!!boot.user} onNavigate={go} onNotice={setNotice} onError={setError} remoteConfigured={capabilities.remoteBrowser} scheduledReady={!!capabilities.scheduled} codeExecutionConfigured={!!capabilities.codeExecution}/>}
 {view === 'scheduled' && <TaskManager signedIn={!!boot.user} onNavigate={go} modelId={modelId} onRunComplete={() => loadChats()}/>}
 {view === 'notebooks' && <NotebookPage signedIn={!!boot.user} onNavigate={go} onAttach={(id:string) => {setAttached([id]);go('/chat');}} onFilesChanged={loadFiles}/>}
 {view === 'browser' && <BrowserSessionPage signedIn={!!boot.user} remoteConfigured={capabilities.remoteBrowser} onNavigate={go}/>}
 {view === 'music' && <MusicWorkspace configured={!!capabilities.music} signedIn={!!boot.user} busy={busy} assets={mediaAssets.filter(asset=>asset.kind==='music'&&asset.status==='complete')} onGenerate={text=>generateMedia('music',text)} onNavigate={go}/>}
 </DeferredPanel></main>{view === 'chat' && <p className="prism-desktop-disclaimer">OpenPrism은 실수를 할 수 있습니다. 중요한 정보는 확인해주세요.</p>}<footer className="app-footer"><span>{'Gemini 3.5 Flash-Lite 무료 · 유료 모델은 크레딧 차감'}</span><span>Made for curious minds <span className="footer-spark">✦</span></span></footer></div>
 {searchOpen && <DeferredPanel label="채팅 검색" dialog onClose={() => setSearchOpen(false)}><ChatSearchDialog open={searchOpen} onOpenChange={setSearchOpen} onNavigate={go} signedIn={!!boot.user}/></DeferredPanel>}
 {driveOpen && <DeferredPanel label="Google Drive" dialog onClose={() => setDriveOpen(false)}><DrivePickerDialog open={driveOpen} onOpenChange={setDriveOpen} signedIn={!!boot.user} onFile={file=>upload(file,true)} onNavigate={go}/></DeferredPanel>}
 <NotebookDialog open={notebookOpen} onOpenChange={setNotebookOpen} onCreate={createNotebook}/>
 {shareOpen && <Modal title="대화 공유" close={() => { if (!shareBusy) setShareOpen(false); }}>
   <p className="modal-intro">공개 링크를 아는 누구나 로그인 없이 이 대화의 사본을 볼 수 있고 다른 사람에게 전달할 수 있습니다. 첨부 파일 원문은 제외되지만, 메시지에 직접 작성하거나 AI가 인용한 개인정보·기밀 내용은 공개됩니다. 이후의 새 메시지는 추가되지 않습니다.</p>
   {shareUrl ? <>
     <label className="prism-share-url-label">공개 링크<input readOnly value={shareUrl} onFocus={event => event.currentTarget.select()}/></label>
     <p className="prism-share-expiry-note">{shareExpiresAt === null ? '자동 만료 없음 · 직접 공유를 취소할 때까지 열람할 수 있습니다.' : '자동 만료: ' + new Date(shareExpiresAt).toLocaleString('ko-KR')}</p>
     <div className="modal-actions"><button type="button" className="secondary-button" data-copied={isCopied('share-link', shareUrl)} onClick={() => void copy('share-link', shareUrl, '링크가 복사되었습니다.')}>{isCopied('share-link', shareUrl) ? <Check size={15}/> : <Copy size={15}/>}{isCopied('share-link', shareUrl) ? '링크 복사됨' : '링크 복사'}</button><button className="primary-button" onClick={() => { setShareOpen(false); go('/sharing'); }}>공개 링크 관리</button></div>
   </> : <>
     {sharePreviewLoading ? <p className="prism-share-expiry-note" role="status"><LoaderCircle size={16} className="spin"/>공개될 내용 불러오는 중…</p> : sharePreview && <details className="prism-share-preview" open>
       <summary>공개될 내용 미리보기 · {sharePreview.messages.length}개 메시지</summary>
       <div className="prism-share-preview-content" tabIndex={0} aria-label="공개될 대화 내용"><h3>{sharePreview.title}</h3>{sharePreview.messages.map((message, index) => <section key={index}><h4>{message.role === 'user' ? '질문' : 'Prism'}</h4><p>{message.content}</p></section>)}</div>
     </details>}
     <label className="prism-share-expiry-control">자동 만료<select value={shareExpiry} disabled={shareBusy} onChange={event => { setShareExpiry(event.target.value); setShareReviewed(false); }}><option value="1">1일 후</option><option value="7">7일 후 (기본)</option><option value="30">30일 후</option><option value="never">만료 없음</option></select></label>
     {shareExpiry === 'never' && <p className="prism-share-expiry-note">만료 없음을 선택하면 직접 공유를 취소할 때까지 링크가 유지됩니다.</p>}
     <label className="prism-share-review"><input type="checkbox" checked={shareReviewed} disabled={shareBusy || !sharePreview || sharePreviewLoading} onChange={event => setShareReviewed(event.target.checked)}/><span>위 미리보기에서 공개할 내용과 만료 기간을 확인했으며, 링크를 가진 누구나 볼 수 있다는 점에 동의합니다.</span></label>
     <p className="prism-share-expiry-note">내 공개 링크에서 언제든지 공유를 취소할 수 있습니다. 이미 복사되거나 저장된 내용은 회수되지 않습니다.</p>
     {shareError && <p className="prism-form-error" role="alert">{shareError}</p>}
     <div className="modal-actions"><button className="secondary-button" disabled={shareBusy || sharePreviewLoading} onClick={() => setSharePreviewAttempt(value => value + 1)}>미리보기 새로고침</button><button className="primary-button" disabled={shareBusy || sharePreviewLoading || !shareReviewed || !sharePreview} onClick={createShare}>{shareBusy ? '생성 중…' : '공개 링크 만들기'}</button></div>
   </>}
 </Modal>}
 {(copyNotice || notice) && <div key={copyNotice ? copyNoticeKey : 'notice'} className="toast" role="status" aria-live="polite" aria-atomic="true"><CheckCircle2 size={16}/>{copyNotice || notice}</div>}
 {help && <Modal title="A little guide to Prism" close={() => setHelp(false)}><p className="modal-intro">Your next big idea is a conversation away.</p><div className="guide-steps">{[[MessageSquare, 'Start with a question', 'Choose a model, set your reasoning level, and send your prompt.'], [Columns2, 'Get another perspective', 'Compare two or three models with the same prompt.'], [FolderOpen, 'Bring your context', 'Upload a text document and attach it to any conversation.']].map(([Icon, title, text]: any) => <div key={title}><span><Icon size={20}/></span><div><h3>{title}</h3><p>{text}</p></div></div>)}</div><div className="guide-note"><PlugZap size={18}/><p>{connected ? 'Your configured providers are ready for API requests.' : 'Connect provider API accounts in Settings to enable real responses.'}</p></div><button className="primary-button full" onClick={() => { setHelp(false); go(connected ? '/chat' : '/settings'); }}>{connected ? 'Let’s get started' : 'Go to connections'}<ArrowRight size={15}/></button></Modal>}
 {deleteTarget && <Modal title={deleteTarget.kind === 'files' ? '파일을 삭제할까요?' : '대화를 삭제할까요?'} close={() => { if (!deleting) setDeleteTarget(null); }}><p className="modal-intro">“{deleteTarget.title}”{deleteTarget.kind === 'files' ? ' 파일이 삭제됩니다.' : ' 대화와 메시지, 공개 공유 링크 및 이 대화에서 생성한 파일이 삭제됩니다.'} 삭제한 내용은 복구할 수 없습니다.</p>{deleteError && <p className="prism-form-error" role="alert">{deleteError}</p>}<div className="modal-actions"><button className="secondary-button" disabled={deleting} onClick={() => setDeleteTarget(null)}>취소</button><button className="danger-button" disabled={deleting} onClick={remove}>{deleting ? <LoaderCircle size={14} className="spin"/> : <Trash2 size={14}/>} {deleting ? '삭제 중…' : '삭제'}</button></div></Modal>}
 {rename && <Modal title="대화 이름 변경" close={() => { if (!renaming) setRename(null); }}><form onSubmit={async (e) => {
        e.preventDefault(); if (renaming || !rename.title.trim()) return;
        const target = { ...rename, title: rename.title.trim() };
        setRenaming(true); setRenameError('');
        try {
            await api('conversations/' + encodeURIComponent(target.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: target.title }) });
            chatsRequest.current++;
            setChats(current => current.map(chat => chat.id === target.id ? { ...chat, title: target.title } : chat));
            setRename(null); setNotice('대화 이름을 변경했습니다.');
            void loadChats();
        } catch (e) { setRenameError(e instanceof Error ? e.message : '이름을 변경하지 못했습니다.'); }
        finally { setRenaming(false); }
    }}><input className="rename-input" autoFocus aria-label="대화 제목" value={rename.title} disabled={renaming} maxLength={100} onChange={e => setRename({ ...rename, title: e.target.value })}/>{renameError && <p className="prism-form-error" role="alert">{renameError}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={renaming} onClick={() => setRename(null)}>취소</button><button type="submit" className="primary-button" disabled={renaming || !rename.title.trim()}>{renaming ? <LoaderCircle size={14} className="spin"/> : <Check size={14}/>} {renaming ? '저장 중…' : '저장'}</button></div></form></Modal>}
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
}) {
    const ref = useRef<HTMLDivElement>(null);
    const closeRef = useRef(close);
    closeRef.current = close;
    useEffect(() => {
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const el = ref.current;
        const initial = el?.querySelector<HTMLElement>('input:not([disabled]), [data-initial-focus], .modal-actions .secondary-button:not([disabled])');
        (initial || el)?.focus();
        function trap(event: KeyboardEvent) {
            if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
            if (event.key !== 'Tab' || !el) return;
            const nodes = [...el.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(node => node.getClientRects().length);
            if (!nodes.length) { event.preventDefault(); el.focus(); return; }
            const first = nodes[0], last = nodes[nodes.length - 1];
            const outside = document.activeElement === el || !el.contains(document.activeElement);
            if (event.shiftKey && (outside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && (outside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
        }
        document.addEventListener('keydown', trap);
        return () => {
            document.removeEventListener('keydown', trap);
            if (previous?.isConnected && previous.getClientRects().length && !previous.closest('[inert]')) previous.focus();
            else document.querySelector<HTMLElement>('main textarea, header button[aria-label="새 채팅"]')?.focus();
        };
    }, []);
    return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><div className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="닫기" onClick={close}><X size={19}/></button></div>{children}</div></div>;
}
