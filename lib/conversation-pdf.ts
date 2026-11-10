import { PDFDocument, PDFHexString, PDFName, PDFOperator, PDFOperatorNames, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { parseMarkdownTable, readMarkdownCodeSpan, type MarkdownTable } from './markdown-table';

export type ConversationPdfInput = {
  title: string;
  messages: readonly { role: string; content: string }[];
};

/** A fallback glyph image uses em units, preserving the measured text advance. */
export type PdfGlyphImage = {
  bytes: Uint8Array;
  advance: number;
  width: number;
  height: number;
  left: number;
  bottom: number;
};

export type ConversationPdfAssets = {
  regular: Uint8Array;
  fallback: Uint8Array;
  renderGlyph?: (text: string) => Promise<PdfGlyphImage>;
};

const MARGIN = 42;
const INK = rgb(.12, .13, .15);
const MUTED = rgb(.37, .4, .45);
const ACCENT = rgb(.13, .32, .69);
const RULE = rgb(.82, .84, .87);
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

type Font = { font: PDFFont; characters: Set<number> };
type Glyph = PdfGlyphImage & { image: PDFImage };
type Unit = { text: string; width: number; font?: PDFFont; glyph?: Glyph };

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), value => value.segment);
}

function cleanText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
      value => `[U+${value.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`);
}

/** Preserve the text and destination of links without printing Markdown syntax. */
export function pdfInlineText(text: string): string {
  let result = '', index = 0;
  while (index < text.length) {
    if (text[index] === '\\' && /[!-/:-@[-`{-~]/.test(text[index + 1] || '')) {
      result += text[index + 1]; index += 2; continue;
    }
    if (text[index] === '`') {
      const span = readMarkdownCodeSpan(text, index);
      if (span) { result += span.content.replace(/\\\|/g, '|'); index = span.end; continue; }
    }
    const strong = text[index] === '*' ? /^\*\*([^*\n]+)\*\*/.exec(text.slice(index)) : null;
    if (strong) { result += pdfInlineText(strong[1]); index += strong[0].length; continue; }
    const link = text[index] === '[' ? /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.exec(text.slice(index)) : null;
    if (link) { result += `${pdfInlineText(link[1])} (${link[2]})`; index += link[0].length; continue; }
    result += text[index++];
  }
  return result;
}

/**
 * Build a text PDF directly from the conversation, never a screen capture.
 * Pages are added only immediately before drawing real content, which prevents
 * an empty trailing page after an exact page boundary or final paragraph gap.
 */
export async function createConversationPdf(input: ConversationPdfInput, assets: ConversationPdfAssets,
  pageSize: readonly [number, number] = [595.28, 841.89]): Promise<Uint8Array> {
  const [PAGE_WIDTH, PAGE_HEIGHT] = pageSize;
  if (!Number.isFinite(PAGE_WIDTH) || !Number.isFinite(PAGE_HEIGHT) || PAGE_WIDTH < 200 || PAGE_HEIGHT < 200) {
    throw new Error('올바른 PDF 페이지 크기가 필요합니다.');
  }
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
  const CONTENT_HEIGHT = PAGE_HEIGHT - MARGIN * 2;
  const messages = input.messages.filter(message => typeof message.content === 'string' && message.content.trim());
  if (!messages.length) throw new Error('PDF로 저장할 대화가 없습니다.');
  const title = cleanText(input.title.trim() || 'Prism 대화');
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const embedded = await Promise.all([assets.regular, assets.fallback].map(bytes => doc.embedFont(bytes, {
    subset: true, features: { kern: false, liga: false },
  })));
  const fonts: Font[] = embedded.map(font => ({ font, characters: new Set(font.getCharacterSet()) }));
  const glyphs = new Map<string, Glyph>();
  const fontCache = new Map<string, PDFFont | null>();
  const widthCache = new Map<string, number>();
  function chooseFont(text: string): PDFFont | undefined {
    if (!fontCache.has(text)) {
      fontCache.set(text, fonts.find(entry => Array.from(text).every(character => entry.characters.has(character.codePointAt(0)!)))?.font ?? null);
    }
    return fontCache.get(text) ?? undefined;
  }

  const prepared = messages.map(message => ({ ...message, content: cleanText(message.content) }));
  const allText = [title, 'Prism · 대화 내보내기 나 메시지', ...prepared.flatMap(message => [message.role, message.content])].join('\n');
  for (const text of new Set(graphemes(allText))) {
    if (/^\s+$/.test(text) || chooseFont(text)) continue;
    if (!assets.renderGlyph) {
      const codepoints = Array.from(text, character => `U+${character.codePointAt(0)!.toString(16).toUpperCase()}`).join(' ');
      throw new Error(`PDF 글꼴에서 지원하지 않는 문자가 있습니다 (${codepoints}).`);
    }
    const rendered = await assets.renderGlyph(text);
    if (!rendered.bytes.length || !Number.isFinite(rendered.advance) || rendered.advance <= 0) {
      throw new Error('일부 문자를 PDF에 표시하지 못했습니다. 다시 시도해 주세요.');
    }
    glyphs.set(text, { ...rendered, image: await doc.embedPng(rendered.bytes) });
  }

  let page: PDFPage;
  let y = 0;
  function addPage() { page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]); y = PAGE_HEIGHT - MARGIN; }
  function ensureSpace(height: number) {
    if (!page || y - height < MARGIN - .001) addPage();
  }
  function units(text: string, size: number): Unit[] {
    return graphemes(text).map(character => {
      const font = chooseFont(character);
      const glyph = glyphs.get(character);
      if (!font && !glyph) throw new Error('PDF 문자 정보를 준비하지 못했습니다.');
      const key = `${size}:${character}`;
      if (!widthCache.has(key)) widthCache.set(key, font ? font.widthOfTextAtSize(character, size) : glyph!.advance * size);
      return { text: character, width: widthCache.get(key)!, font, glyph };
    });
  }
  function wrap(text: string, size: number, width: number, preserveSpaces = false): Unit[][] {
    const lines: Unit[][] = [];
    for (const original of text.split('\n')) {
      const pending = units(original, size);
      let line: Unit[] = [], used = 0;
      for (const unit of pending) {
        if (line.length && used + unit.width > width + .001) {
          let cut = line.length;
          if (!preserveSpaces) {
            const space = line.findLastIndex(item => /^\s+$/.test(item.text));
            if (space > 0) cut = space + 1;
          }
          const first = line.slice(0, cut);
          if (!preserveSpaces) while (first.length && /^\s+$/.test(first.at(-1)!.text)) first.pop();
          lines.push(first);
          line = line.slice(cut); used = line.reduce((sum, item) => sum + item.width, 0);
          if (line.length && used + unit.width > width + .001) { lines.push(line); line = []; used = 0; }
        }
        if (!preserveSpaces && !line.length && /^\s+$/.test(unit.text)) continue;
        line.push(unit); used += unit.width;
      }
      lines.push(line);
    }
    return lines;
  }
  function lineWidth(line: Unit[]): number { return line.reduce((sum, unit) => sum + unit.width, 0); }
  function drawLine(line: Unit[], x: number, baseline: number, size: number, color = INK) {
    let pending = '', pendingFont: PDFFont | undefined;
    const flush = () => {
      if (pending && pendingFont) {
        page.drawText(pending, { x, y: baseline, font: pendingFont, size, color });
        x += pendingFont.widthOfTextAtSize(pending, size);
      }
      pending = ''; pendingFont = undefined;
    };
    for (const unit of line) {
      if (unit.font) {
        if (pendingFont && pendingFont !== unit.font) flush();
        pendingFont = unit.font; pending += unit.text;
      } else if (unit.glyph) {
        flush();
        const glyph = unit.glyph;
        page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
          PDFName.of('Span'), doc.context.obj({ ActualText: PDFHexString.fromText(unit.text) }).toString(),
        ]));
        page.drawImage(glyph.image, { x: x - glyph.left * size, y: baseline - glyph.bottom * size,
          width: glyph.width * size, height: glyph.height * size });
        page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
        x += unit.width;
      }
    }
    flush();
  }
  function textBlock(text: string, options: { size?: number; color?: ReturnType<typeof rgb>; indent?: number; code?: boolean } = {}) {
    const size = options.size ?? 11;
    const lineHeight = size * (options.code ? 1.55 : 1.65);
    const indent = options.indent ?? 0;
    for (const line of wrap(text, size, CONTENT_WIDTH - indent, !!options.code)) {
      if (!line.some(unit => unit.text.trim())) { y -= lineHeight; continue; }
      ensureSpace(lineHeight);
      if (options.code) page.drawRectangle({ x: MARGIN + indent - 4, y: y - lineHeight,
        width: CONTENT_WIDTH - indent + 8, height: lineHeight, color: rgb(.95, .96, .97) });
      drawLine(line, MARGIN + indent, y - size * 1.15, size, options.color ?? INK);
      y -= lineHeight;
    }
  }

  function tableBlock(table: MarkdownTable) {
    // Very wide tables remain readable as labeled rows instead of clipped columns.
    if (table.headers.length > 8) {
      if (!table.rows.length) textBlock(table.headers.map(pdfInlineText).join(' · '), { size: 10 });
      table.rows.forEach((row, index) => {
        ensureSpace(36); textBlock(`행 ${index + 1}`, { size: 10, color: ACCENT });
        row.forEach((cell, column) => textBlock(`${pdfInlineText(table.headers[column])}: ${pdfInlineText(cell)}`, { size: 10, indent: 10 }));
        y -= 8;
      });
      return;
    }
    const size = 9.3, lineHeight = 14.5, padding = 5;
    const columnWidth = CONTENT_WIDTH / table.headers.length;
    const cells = (row: string[]) => row.map(cell => wrap(pdfInlineText(cell), size, columnWidth - padding * 2));
    const header = cells(table.headers);
    const headerLines = Math.max(1, ...header.map(cell => cell.length));
    const headerHeight = headerLines * lineHeight + padding * 2;
    const canRepeatHeader = headerHeight < CONTENT_HEIGHT / 3;
    let headerComplete = false;

    function drawChunk(row: Unit[][][], offset: number, count: number, isHeader: boolean) {
      const height = count * lineHeight + padding * 2;
      const top = y;
      row.forEach((cell, column) => {
        const left = MARGIN + column * columnWidth;
        page.drawRectangle({ x: left, y: top - height, width: columnWidth, height,
          color: isHeader ? rgb(.94, .95, .97) : rgb(1, 1, 1), borderColor: RULE, borderWidth: .5 });
        cell.slice(offset, offset + count).forEach((line, index) => {
          const alignment = table.alignments[column];
          const inset = alignment === 'right' ? columnWidth - padding - lineWidth(line)
            : alignment === 'center' ? (columnWidth - lineWidth(line)) / 2 : padding;
          drawLine(line, left + inset, top - padding - size * 1.15 - index * lineHeight, size);
        });
      });
      y -= height;
    }
    function nextTablePage() {
      addPage();
      if (headerComplete && canRepeatHeader) drawChunk(header, 0, headerLines, true);
    }
    function rowBlock(row: Unit[][][], isHeader: boolean) {
      const total = Math.max(1, ...row.map(cell => cell.length));
      const fullHeight = total * lineHeight + padding * 2;
      const pageCapacity = CONTENT_HEIGHT - (headerComplete && canRepeatHeader ? headerHeight : 0);
      if (fullHeight <= pageCapacity && y - fullHeight < MARGIN) nextTablePage();
      let offset = 0;
      while (offset < total) {
        if (y - MARGIN < lineHeight + padding * 2) nextTablePage();
        const capacity = Math.max(1, Math.floor((y - MARGIN - padding * 2) / lineHeight));
        const count = Math.min(total - offset, capacity);
        drawChunk(row, offset, count, isHeader); offset += count;
        if (offset < total) nextTablePage();
      }
    }
    rowBlock(header, true); headerComplete = true;
    table.rows.forEach(row => rowBlock(cells(row), false));
    y -= 10;
  }

  function markdown(text: string) {
    const lines = text.split('\n');
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index++; continue; }
      const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        const closing = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}[ \\t]*$');
        const code: string[] = []; index++;
        while (index < lines.length && !closing.test(lines[index])) code.push(lines[index++]);
        if (index < lines.length) index++;
        if (!fence[2].trim() && !code.some(line => line.trim())) continue;
        ensureSpace(32);
        if (fence[2].trim()) textBlock(fence[2].trim(), { size: 8, color: MUTED });
        textBlock(code.join('\n'), { size: 9, indent: 6, code: true }); y -= 10;
        continue;
      }
      const table = parseMarkdownTable(lines, index);
      if (table) { tableBlock(table); index = table.nextLine; continue; }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) {
        const size = heading[1].length === 1 ? 16 : heading[1].length === 2 ? 14 : 12;
        ensureSpace(size * 1.65 + 22); textBlock(pdfInlineText(heading[2]), { size }); y -= 5; index++;
        continue;
      }
      const list = /^(\s*)([-*+] |\d+[.)]\s+)(.*)$/.exec(line);
      if (list) {
        const prefix = /^\d/.test(list[2]) ? list[2].trim() + ' ' : '• ';
        textBlock(prefix + pdfInlineText(list[3]), { indent: Math.min(list[1].length * 4, 40) + 10 });
        y -= 3; index++; continue;
      }
      if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
        ensureSpace(10); page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, color: RULE, thickness: .5 });
        y -= 10; index++; continue;
      }
      const paragraph: string[] = [line]; index++;
      while (index < lines.length && lines[index].trim()
        && !/^(?: {0,3}(?:`{3,}|~{3,})|#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[index])
        && !parseMarkdownTable(lines, index)) paragraph.push(lines[index++]);
      textBlock(pdfInlineText(paragraph.join('\n'))); y -= 8;
    }
  }

  addPage();
  textBlock(title, { size: 18 }); y -= 4;
  textBlock('Prism · 대화 내보내기', { size: 9, color: MUTED }); y -= 16;
  for (const message of prepared) {
    ensureSpace(42);
    const author = message.role === 'user' ? '나' : message.role === 'assistant' ? 'Prism' : message.role || '메시지';
    textBlock(author, { size: 10, color: ACCENT }); y -= 5;
    if (message.role === 'assistant') markdown(message.content);
    else textBlock(message.content);
    y -= 18;
  }

  const pages = doc.getPages();
  pages.forEach((sheet, index) => {
    const text = `${index + 1} / ${pages.length}`;
    sheet.drawText(text, { x: PAGE_WIDTH - MARGIN - embedded[0].widthOfTextAtSize(text, 8), y: 23,
      font: embedded[0], size: 8, color: MUTED });
  });
  doc.setTitle(input.title || 'Prism 대화');
  doc.setCreator('Prism'); doc.setProducer('Prism'); doc.setLanguage('ko-KR');
  // The original UTF-8 transcript preserves exact Markdown and any image glyphs.
  const transcript = [input.title, ...messages.map(message => `${message.role}\n\n${message.content}`)].join('\n\n---\n\n');
  await doc.attach(new TextEncoder().encode(transcript), 'prism-conversation.txt', {
    mimeType: 'text/plain;charset=utf-8', description: 'Original conversation text',
  });
  return doc.save();
}
