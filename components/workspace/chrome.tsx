'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog, DropdownMenu } from 'radix-ui';
import { Check, Download, LoaderCircle, Menu, PenLine, Settings, X } from 'lucide-react';
import { ConversationActions } from './conversation-actions';

export { PrismMark } from '../brand/prism-mark';

type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
type WorkspaceHeaderProps = {
  onMenu(): void;
  onNew(): void;
  onNotice(message: string): void;
  showNavigation: boolean;
  conversation?: { id: string; title: string };
  onRename?(): void;
  onDelete?(): void;
  onPin?(): void | Promise<void>;
  isPinned?: boolean;
  onDownloadPdf?(): void | Promise<void>;
  onExportDocs?(): void | Promise<void>;
  onShare?(): void;
  shareDisabled?: boolean;
  exportBusy?: boolean;
  conversationMenuItems?: ReactNode;
  conversationActions?: ReactNode;
  inConversation?: boolean;
  newDisabled?: boolean;
};
export function WorkspaceHeader({ onMenu, onNew, onNotice, showNavigation, conversation, onRename, onDelete, onPin, isPinned, onDownloadPdf, onExportDocs, onShare, shareDisabled, exportBusy, conversationMenuItems, conversationActions, inConversation = false, newDisabled = false }: WorkspaceHeaderProps) {
  const install = useRef<InstallEvent | null>(null);
  const [printClean, setPrintClean] = useState(true);
  const [installHelp, setInstallHelp] = useState(false);
  const activeConversation = inConversation || !!conversation;
  const hasConversationMenu = !!(conversation && onRename && onDelete);
  useEffect(() => {
    const receive = (event: Event) => { event.preventDefault(); install.current = event as InstallEvent; };
    window.addEventListener('beforeinstallprompt', receive);
    return () => window.removeEventListener('beforeinstallprompt', receive);
  }, []);
  async function installApp() {
    if (!install.current) { setInstallHelp(true); return; }
    try { await install.current.prompt(); const choice = await install.current.userChoice; if (choice.outcome === 'accepted') onNotice('Prism 앱 설치를 시작했습니다.'); }
    catch { onNotice('브라우저 메뉴에서 앱 설치를 선택해주세요.'); }
    finally { install.current = null; }
  }
  return <header className="gemini-topbar" data-conversation={activeConversation}>
    <button type="button" className={'gemini-mobile-toggle' + (showNavigation ? ' is-visible' : '')} aria-label="탐색 메뉴 열기" onClick={onMenu}><Menu size={22}/></button>
    {conversation && <span className="sr-only">{conversation.title}</span>}
    <div className="gemini-top-actions">
      {!activeConversation && <button type="button" className="gemini-install" aria-label="앱 설치" onClick={installApp}><Download size={17}/><span>앱 설치</span></button>}
      {!activeConversation && <div className="gemini-pdf-group">
        <button type="button" className="gemini-pdf-button" onClick={() => { void import('../../lib/print-conversation').then(module => module.printConversation(printClean)).catch(failure => onNotice(failure instanceof Error ? failure.message : '인쇄 창을 열지 못했습니다.')); }}>PDF로 저장</button>
        <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className="gemini-pdf-settings" aria-label="PDF 저장 설정"><Settings size={16}/></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="prism-tool-menu" sideOffset={8} align="end" collisionPadding={8}><DropdownMenu.CheckboxItem className="prism-tool-item" checked={printClean} onCheckedChange={setPrintClean}>대화와 본문만 인쇄<DropdownMenu.ItemIndicator><Check size={16}/></DropdownMenu.ItemIndicator></DropdownMenu.CheckboxItem><DropdownMenu.Label className="prism-tool-note">인쇄 창에서 PDF로 저장을 선택하세요.</DropdownMenu.Label></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
      </div>}
      {!hasConversationMenu && conversationActions}
      {conversation && onRename && onDelete && <ConversationActions key={conversation.id} title={conversation.title} variant="header" onRename={onRename} onDelete={onDelete} onPin={onPin} isPinned={isPinned} onDownloadPdf={onDownloadPdf} onExportDocs={onExportDocs} onShare={onShare} shareDisabled={shareDisabled} exportBusy={exportBusy} disabled={newDisabled}>{conversationMenuItems}</ConversationActions>}
      {!activeConversation && <button type="button" disabled={newDisabled} className="gemini-new-button" onClick={onNew} aria-label="새 채팅" title="새 채팅 (Ctrl+Shift+O)" aria-keyshortcuts="Control+Shift+O Meta+Shift+O"><PenLine size={19}/></button>}
    </div>
    <Dialog.Root open={installHelp} onOpenChange={setInstallHelp}><Dialog.Portal><Dialog.Overlay className="prism-dialog-overlay"/><Dialog.Content className="prism-dialog-content"><div className="prism-dialog-heading"><Dialog.Title>Prism 앱 설치</Dialog.Title><Dialog.Close className="prism-icon" aria-label="닫기"><X size={20}/></Dialog.Close></div><Dialog.Description>브라우저에서 설치 기능을 제공하면 주소 표시줄의 설치 아이콘을 누르세요. Chrome 메뉴의 ‘전송, 저장, 공유’에서도 앱 설치 옵션을 확인할 수 있습니다.</Dialog.Description><p>설치 옵션이 없는 브라우저에서는 이 페이지를 북마크하여 사용할 수 있습니다.</p><Dialog.Close className="prism-primary-button">확인</Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
  </header>;
}

export function NotebookDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange(open: boolean): void; onCreate(file: File): Promise<void> }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!title.trim() || saving) return;
    setSaving(true); setError('');
    try {
      const name = title.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 100);
      await onCreate(new File([`# ${title.trim()}\n\n${content}`], `${name}.md`, { type: 'text/markdown' }));
      setTitle(''); setContent(''); onOpenChange(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '노트북을 저장하지 못했습니다.'); }
    finally { setSaving(false); }
  }
  return <Dialog.Root open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }}><Dialog.Portal><Dialog.Overlay className="prism-dialog-overlay"/><Dialog.Content className="prism-dialog-content prism-notebook-dialog"><form onSubmit={save}><div className="prism-dialog-heading"><Dialog.Title>새 노트북</Dialog.Title><Dialog.Close className="prism-icon" aria-label="닫기" disabled={saving}><X size={20}/></Dialog.Close></div><Dialog.Description>노트를 문서로 저장하고 채팅에 첨부해 활용하세요.</Dialog.Description><label>이름<input disabled={saving} autoFocus required maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder="노트북 이름"/></label><label>노트<textarea disabled={saving} rows={8} maxLength={50000} value={content} onChange={event => setContent(event.target.value)} placeholder="아이디어나 참고할 내용을 적어주세요"/></label>{error && <p role="alert" className="prism-form-error">{error}</p>}<div className="prism-dialog-actions"><Dialog.Close className="prism-secondary-button" disabled={saving}>취소</Dialog.Close><button className="prism-primary-button" type="submit" disabled={saving || !title.trim()}>{saving && <LoaderCircle size={16} className="spin"/>}만들기</button></div></form></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
