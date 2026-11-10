import type { ConversationPdfInput } from './conversation-pdf';

export type { ConversationPdfInput } from './conversation-pdf';

export type ConversationPrintMessage = ConversationPdfInput['messages'][number] & { id?: string };
export type ConversationPrintInput = Omit<ConversationPdfInput, 'messages'> & {
  messages: readonly ConversationPrintMessage[];
};
type PrintOptions = { renderedMessages?: HTMLElement | null };
type PrintJob = { cleanup(): void };

let activePrintJob: PrintJob | undefined;

const screenOnly = [
  '.prism-response-actions', '.prism-user-actions', '.message-copy',
  '.prism-thinking', '[role="status"]', '.sr-only',
  'button', 'input', 'textarea', 'select', 'script', 'style', 'link',
  'iframe', 'object', 'embed',
].join(',');

// Freeze presentation, not element heights or scroll containers. This keeps the
// exact screen typography/theme (including a mobile export) while allowing the
// browser to paginate selectable text instead of clipping a screenshot.
const presentationProperties = [
  'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch',
  'font-variant', 'font-feature-settings', 'line-height', 'letter-spacing',
  'word-spacing', 'text-align', 'text-indent', 'text-transform',
  'text-decoration-line', 'text-decoration-color', 'text-decoration-thickness',
  'text-underline-offset', 'white-space', 'tab-size', 'color', 'background-color',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-right-radius', 'border-bottom-left-radius',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-bottom', 'list-style-type', 'list-style-position',
] as const;

const themeProperties = [
  '--prism-page', '--prism-sidebar', '--prism-surface', '--prism-surface-raised',
  '--prism-composer', '--prism-ink', '--prism-muted', '--prism-placeholder',
  '--prism-border', '--prism-hover', '--prism-accent', '--prism-selected',
] as const;

function nextPaint(): Promise<void> {
  return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
}

async function readyToPrint(): Promise<void> {
  let timeout: number | undefined;
  try {
    await Promise.race([
      document.fonts.ready,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error('글꼴을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.')), 15_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
  // Menus/portals finish closing before the browser takes its print snapshot.
  await nextPaint();
  await nextPaint();
}

function filename(title: string): string {
  return title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 120) || 'Prism 대화';
}

function capturePresentation(source: HTMLElement, target: HTMLElement): void {
  const originals = [source, ...source.querySelectorAll<HTMLElement>('*')];
  const copies = [target, ...target.querySelectorAll<HTMLElement>('*')];
  originals.forEach((original, index) => {
    const copy = copies[index];
    if (!copy?.style) return;
    const style = window.getComputedStyle(original);
    for (const property of presentationProperties) {
      copy.style.setProperty(property, style.getPropertyValue(property));
    }
    if (original.matches('.message.user')) {
      // A computed margin-left is a fixed pixel offset, so retain the stylesheet's
      // auto margin and only preserve the bubble's measured width.
      copy.style.width = `${original.getBoundingClientRect().width}px`;
      copy.style.maxWidth = '100%';
    }
  });
}

function removeScreenControls(root: HTMLElement): void {
  root.querySelectorAll(screenOnly).forEach(element => element.remove());
  for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    element.removeAttribute('id');
    element.removeAttribute('data-streaming');
    element.removeAttribute('aria-live');
    element.removeAttribute('aria-busy');
    element.removeAttribute('tabindex');
    // The clone contains only already-sanitized rendered content. Do not retain
    // any inline event attributes if a future renderer starts supplying them.
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.startsWith('on')) element.removeAttribute(attribute.name);
    }
  }
}

function matchingMessages(source: HTMLElement | null | undefined, messages: readonly ConversationPrintMessage[]): HTMLElement[] | null {
  if (!source?.isConnected || source.querySelector('.is-editing, [data-streaming="true"]')) return null;
  const rendered = Array.from(source.children).filter((element): element is HTMLElement =>
    element instanceof HTMLElement && element.classList.contains('message'));
  if (rendered.length !== messages.length) return null;
  if (!rendered.every((element, index) => {
    const message = messages[index];
    if (!element.classList.contains(message.role === 'user' ? 'user' : 'assistant')) return false;
    if (message.id && element.dataset.messageId !== message.id) return false;
    return message.role !== 'user' || element.querySelector('.prism-query-text')?.textContent === message.content;
  })) return null;
  return rendered;
}

/** Own the short-lived print document until the native dialog has closed. */
function beginPrintJob(clean: boolean, title?: string, container?: HTMLElement, dispose?: () => void): PrintJob {
  if (activePrintJob) throw new Error('열린 인쇄 창을 닫은 뒤 다시 시도해 주세요.');
  if (typeof window.print !== 'function') throw new Error('이 브라우저에서는 인쇄를 지원하지 않습니다. 브라우저 메뉴에서 PDF로 저장해 주세요.');
  const html = document.documentElement;
  const oldClean = html.dataset.printClean;
  const oldPrint = html.dataset.prismPrint;
  const oldTitle = document.title;
  const printTitle = title ? filename(title) : oldTitle;
  const media = window.matchMedia('print');
  let enteredPrint = false;
  let finished = false;
  let fallback: number | undefined;
  const job: PrintJob = { cleanup };

  function restoreData(key: 'printClean' | 'prismPrint', value: string | undefined) {
    if (value === undefined) delete html.dataset[key];
    else html.dataset[key] = value;
  }
  function cleanup() {
    if (finished) return;
    finished = true;
    window.removeEventListener('beforeprint', beforePrint);
    window.removeEventListener('afterprint', cleanup);
    window.removeEventListener('pagehide', cleanup);
    window.removeEventListener('focus', focusReturned);
    media.removeEventListener('change', mediaChanged);
    if (fallback !== undefined) window.clearTimeout(fallback);
    dispose?.();
    container?.remove();
    restoreData('printClean', oldClean);
    restoreData('prismPrint', oldPrint);
    if (document.title === printTitle) document.title = oldTitle;
    if (activePrintJob === job) activePrintJob = undefined;
  }
  function beforePrint() {
    enteredPrint = true;
    container?.removeAttribute('aria-hidden');
  }
  function mediaChanged(event: MediaQueryListEvent) {
    if (event.matches) beforePrint();
    else if (enteredPrint) cleanup();
  }
  function focusReturned() {
    // Some mobile browsers omit afterprint. Returning to this document is the
    // fallback; never tear down a document while print media is still active.
    if (enteredPrint && !media.matches) cleanup();
  }

  html.dataset.printClean = String(clean);
  if (container) html.dataset.prismPrint = 'conversation';
  document.title = printTitle;
  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('afterprint', cleanup);
  window.addEventListener('pagehide', cleanup);
  window.addEventListener('focus', focusReturned);
  media.addEventListener('change', mediaChanged);
  // No page/dialog event should leave an invisible transcript in the DOM
  // forever. Browsers with a synchronous print dialog run this after it closes.
  fallback = window.setTimeout(() => { if (!media.matches) cleanup(); }, 120_000);
  activePrintJob = job;
  return job;
}

/** Print another workspace page using its existing clean-print preference. */
export async function printConversation(clean = true): Promise<void> {
  const job = beginPrintJob(clean);
  try {
    await readyToPrint();
    window.print();
  } catch (error) {
    job.cleanup();
    throw error;
  }
}

/**
 * Open native Save as PDF using the chat's own renderer, typography and theme.
 * No transcript is uploaded, no new window is opened, and the live conversation
 * is never restyled or replaced. Native PDF output retains selectable text.
 * Resolving means the print dialog was requested, not that the user saved a PDF.
 */
export async function downloadConversationPdf(input: ConversationPrintInput, options: PrintOptions = {}): Promise<void> {
  const messages = input.messages.filter(message => typeof message.content === 'string' && message.content.trim());
  if (!messages.length) throw new Error('PDF로 저장할 대화가 없습니다.');
  if (activePrintJob) throw new Error('열린 인쇄 창을 닫은 뒤 다시 시도해 주세요.');

  const source = options.renderedMessages;
  const rendered = matchingMessages(source, messages);
  const liveShell = source?.closest<HTMLElement>('.gemini-shell') ?? document.querySelector<HTMLElement>('.gemini-shell');
  const mainWidth = document.querySelector<HTMLElement>('.gemini-main')?.clientWidth ?? document.documentElement.clientWidth;
  const gutter = window.matchMedia('(max-width: 767px)').matches ? 32 : 48;
  const width = rendered && source ? source.getBoundingClientRect().width : Math.min(708, Math.max(200, mainWidth - gutter));
  const host = document.createElement('div');
  host.className = 'app-shell gemini-shell prism-print-root';
  host.setAttribute('aria-hidden', 'true');
  host.style.setProperty('--prism-print-width', `${width}px`);
  if (liveShell) {
    const styles = window.getComputedStyle(liveShell);
    for (const property of themeProperties) host.style.setProperty(property, styles.getPropertyValue(property));
    host.style.fontFamily = styles.fontFamily;
    host.style.colorScheme = styles.colorScheme;
  }
  const screen = document.createElement('div');
  screen.className = 'conversation-screen prism-thread';
  host.appendChild(screen);
  let dispose: (() => void) | undefined;
  let job: PrintJob | undefined;

  try {
    if (rendered && source) {
      const clone = source.cloneNode(true) as HTMLElement;
      capturePresentation(source, clone);
      // Keep only actual messages: the live scroll anchor must not add a page.
      for (const child of Array.from(clone.children)) if (!child.classList.contains('message')) child.remove();
      removeScreenControls(clone);
      screen.appendChild(clone);
    } else {
      // A history-menu export may refer to a conversation that is not mounted.
      // Render the supplied real messages with the same Markdown component as
      // chat, rather than translating them into a second document format.
      const [{ createRoot }, { flushSync }, { createElement }, { ConversationPrintContent }] = await Promise.all([
        import('react-dom/client'), import('react-dom'), import('react'),
        import('../components/workspace/conversation-print-content'),
      ]);
      const root = createRoot(screen);
      dispose = () => root.unmount();
      flushSync(() => root.render(createElement(ConversationPrintContent, { messages })));
    }
    document.body.appendChild(host);
    await readyToPrint();
    if (!rendered) {
      const content = screen.querySelector<HTMLElement>('.messages');
      if (!content) throw new Error('인쇄할 대화를 준비하지 못했습니다. 다시 시도해 주세요.');
      capturePresentation(content, content);
      removeScreenControls(content);
    }
    job = beginPrintJob(true, input.title, host, dispose);
    // This appends only an invisible, non-interactive print copy. The native
    // dialog applies print CSS; the chat's scroll position and draft stay intact.
    window.print();
  } catch (error) {
    if (job) job.cleanup();
    else { dispose?.(); host.remove(); }
    throw error;
  }
}
