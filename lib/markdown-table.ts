export type MarkdownAlignment = 'left' | 'center' | 'right' | undefined;

export type MarkdownTable = {
  headers: string[];
  alignments: MarkdownAlignment[];
  rows: string[][];
  nextLine: number;
};

/** Match an entire backtick run, so a pipe inside `code` is not a column. */
export function readMarkdownCodeSpan(text: string, start: number): { content: string; end: number } | null {
  if (text[start] !== '`') return null;
  let openingEnd = start;
  while (text[openingEnd] === '`') openingEnd++;
  const size = openingEnd - start;
  let cursor = openingEnd;
  while (cursor < text.length) {
    const closingStart = text.indexOf('`', cursor);
    if (closingStart < 0) return null;
    let closingEnd = closingStart;
    while (text[closingEnd] === '`') closingEnd++;
    if (closingEnd - closingStart === size) {
      return { content: text.slice(openingEnd, closingStart), end: closingEnd };
    }
    cursor = closingEnd;
  }
  return null;
}

/** Preserve Markdown escapes for inline rendering; split only structural pipes. */
export function splitMarkdownTableRow(line: string): { cells: string[]; hasPipe: boolean } {
  const text = line.trim();
  const cells: string[] = [];
  let cell = '', index = 0, hasPipe = false;
  let leadingPipe = false, trailingPipe = false;

  while (index < text.length) {
    const char = text[index];
    if (char === '\\' && index + 1 < text.length) {
      cell += text.slice(index, index + 2);
      index += 2;
      trailingPipe = false;
      continue;
    }
    if (char === '`') {
      const code = readMarkdownCodeSpan(text, index);
      let end = code?.end ?? index + 1;
      if (!code) while (text[end] === '`') end++;
      cell += text.slice(index, end);
      index = end;
      trailingPipe = false;
      continue;
    }
    if (char === '|') {
      hasPipe = true;
      if (index === 0) leadingPipe = true;
      cells.push(cell.trim());
      cell = '';
      trailingPipe = index === text.length - 1;
    } else {
      cell += char;
      trailingPipe = false;
    }
    index++;
  }
  cells.push(cell.trim());
  if (leadingPipe) cells.shift();
  if (trailingPipe) cells.pop();
  return { cells: cells.length ? cells : [''], hasPipe };
}

function tableHeader(lines: readonly string[], start: number) {
  if (start + 1 >= lines.length || !lines[start].trim()) return null;
  const header = splitMarkdownTableRow(lines[start]);
  const delimiter = splitMarkdownTableRow(lines[start + 1]);
  // Without a pipe this is ordinary text / a Setext heading, not a table.
  if ((!header.hasPipe && !delimiter.hasPipe) || header.cells.length !== delimiter.cells.length) return null;
  if (!delimiter.cells.every(cell => /^:?-+:?$/.test(cell))) return null;
  const alignments: MarkdownAlignment[] = delimiter.cells.map(cell =>
    cell.startsWith(':') ? cell.endsWith(':') ? 'center' : 'left' : cell.endsWith(':') ? 'right' : undefined,
  );
  return { headers: header.cells, alignments };
}

export function isMarkdownTableStart(lines: readonly string[], start: number): boolean {
  return tableHeader(lines, start) !== null;
}

/** A complete header establishes the table; streaming body rows may be partial. */
export function parseMarkdownTable(lines: readonly string[], start: number): MarkdownTable | null {
  const header = tableHeader(lines, start);
  if (!header) return null;
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length && lines[index].trim()) {
    // Do not consume an adjacent prose paragraph, list, heading, or code fence.
    if (/^\s{0,3}(?:`{3,}|~{3,}|#{1,6}(?:\s|$)|>|[-*+]\s|\d+[.)]\s)/.test(lines[index])) break;
    const row = splitMarkdownTableRow(lines[index]);
    if (!row.hasPipe) break;
    // Missing cells are empty and surplus cells are ignored, as in GFM.
    rows.push(header.headers.map((_, column) => row.cells[column] ?? ''));
    index++;
  }
  return { ...header, rows, nextLine: index };
}
