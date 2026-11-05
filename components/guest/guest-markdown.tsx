import { Fragment, type ReactNode } from 'react';

/** A small text-only Markdown renderer. HTML is always escaped by React. */
function inline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g);
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export default function GuestMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('```')) {
      const language = line.slice(3).trim().slice(0, 30);
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(<div className="pg-code" key={`code-${index}`}>{language && <span>{language}</span>}<pre><code>{code.join('\n')}</code></pre></div>);
      continue;
    }
    if (!line.trim()) { index++; continue; }
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
      blocks.push(ordered ? <ol key={`list-${index}`}>{items}</ol> : <ul key={`list-${index}`}>{items}</ul>);
      continue;
    }
    const paragraph: string[] = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !/^(?:```|#{1,4}\s|[-*]\s|\d+[.)]\s)/.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={`p-${index}`}>{inline(paragraph.join('\n'))}</p>);
  }
  return <div className="pg-markdown">{blocks}</div>;
}
