import { Fragment, type ReactNode } from 'react';
import { isMarkdownTableStart, parseMarkdownTable, readMarkdownCodeSpan } from '../../lib/markdown-table';

/** A small text-only Markdown renderer. HTML is always escaped by React. */
function inline(text: string, inTable = false, allowLinks = true): ReactNode[] {
  const parts: ReactNode[] = [];
  let index = 0, plain = '', plainStart = 0;
  const flush = () => {
    if (plain) parts.push(<Fragment key={`text-${plainStart}`}>{plain}</Fragment>);
    plain = '';
  };
  while (index < text.length) {
    if (!plain) plainStart = index;
    if (text[index] === '\\' && /[!-/:-@[-`{-~]/.test(text[index + 1] || '')) {
      plain += text[index + 1]; index += 2; continue;
    }
    if (text[index] === '`') {
      const code = readMarkdownCodeSpan(text, index);
      if (code) {
        flush();
        let content = code.content.replace(/\n/g, ' ');
        if (content.startsWith(' ') && content.endsWith(' ') && content.trim()) content = content.slice(1, -1);
        // GFM permits an escaped pipe inside a table's inline code span.
        if (inTable) content = content.replace(/\\\|/g, '|');
        parts.push(<code key={`code-${index}`}>{content}</code>);
        index = code.end; continue;
      }
      let end = index + 1;
      while (text[end] === '`') end++;
      plain += text.slice(index, end); index = end; continue;
    }
    const strong = text[index] === '*' ? /^\*\*([^*\n]+)\*\*/.exec(text.slice(index)) : null;
    if (strong) {
      flush(); parts.push(<strong key={`strong-${index}`}>{inline(strong[1], inTable, allowLinks)}</strong>);
      index += strong[0].length; continue;
    }
    const link = allowLinks && text[index] === '[' ? /^\[([^\]\n]{1,500})\]\(((?:https?:\/\/|\/api\/artifacts\/)[^\s)]{1,4096})\)/.exec(text.slice(index)) : null;
    if (link && safeLink(link[2])) {
      flush(); parts.push(<a key={`link-${index}`} href={link[2]} target="_blank" rel="noopener noreferrer">{inline(link[1], inTable, false)}</a>);
      index += link[0].length; continue;
    }
    plain += text[index++];
  }
  flush();
  return parts;
}

function safeLink(href: string): boolean {
  if (/[\\\u0000-\u0020\u007f]/.test(href)) return false;
  // Generated files have one opaque identifier. Do not turn encoded separators,
  // dot segments, query strings, or unrelated internal routes into app links.
  // Absolute HTTP(S) sources remain ordinary external links opened by the user.
  if (href.startsWith('/')) return /^\/api\/artifacts\/[A-Za-z0-9_-]{1,200}$/.test(href);
  try {
    const url = new URL(href);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return false;
    return true;
  } catch { return false; }
}

export default function GuestMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const start = index;
    const line = lines[index];
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      const language = fence[2].trim().slice(0, 30);
      const closingFence = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}[ \\t]*$');
      const code: string[] = [];
      index++;
      while (index < lines.length && !closingFence.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(<div className="pg-code" key={`code-${start}`}>{language && <span>{language}</span>}<pre><code>{code.join('\n')}</code></pre></div>);
      continue;
    }
    if (!line.trim()) { index++; continue; }
    const table = parseMarkdownTable(lines, index);
    if (table) {
      blocks.push(<div className="pg-table-scroll" key={`table-${start}`} role="region" aria-label="표 (가로로 스크롤할 수 있습니다)" tabIndex={0}>
        <table>
          <thead><tr>{table.headers.map((cell, column) => <th scope="col" key={column} style={table.alignments[column] ? { textAlign: table.alignments[column] } : undefined}>{inline(cell, true)}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={table.alignments[column] ? { textAlign: table.alignments[column] } : undefined}>{inline(cell, true)}</td>)}</tr>)}</tbody>
        </table>
      </div>);
      index = table.nextLine;
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      blocks.push(<h3 key={index}>{inline(line.replace(/^#{1,4}\s+/, ''))}</h3>);
      index++;
      continue;
    }
    const ordered = /^\d+[.)]\s/.test(line);
    if (ordered || /^[-*]\s/.test(line)) {
      const items: ReactNode[] = [];
      const pattern = ordered ? /^\d+[.)]\s+/ : /^[-*]\s+/;
      while (index < lines.length && pattern.test(lines[index])) {
        items.push(<li key={index}>{inline(lines[index].replace(pattern, ''))}</li>);
        index++;
      }
      blocks.push(ordered ? <ol key={`list-${start}`}>{items}</ol> : <ul key={`list-${start}`}>{items}</ul>);
      continue;
    }
    const paragraph: string[] = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !/^(?: {0,3}(?:`{3,}|~{3,})|#{1,4}\s|[-*]\s|\d+[.)]\s)/.test(lines[index]) && !isMarkdownTableStart(lines, index)) paragraph.push(lines[index++]);
    blocks.push(<p key={`p-${start}`}>{inline(paragraph.join('\n'))}</p>);
  }
  return <div className="pg-markdown">{blocks}</div>;
}
