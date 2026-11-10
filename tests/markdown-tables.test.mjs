import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const runtime = new URL('../.sites-runtime/markdown-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
for (const [input, output] of [
  ['../lib/markdown-table.ts', 'markdown-table.mjs'],
  ['../components/guest/guest-markdown.tsx', 'guest-markdown.mjs'],
]) {
  const source = (await readFile(new URL(input, import.meta.url), 'utf8'))
    .replace("'../../lib/markdown-table'", "'./markdown-table.mjs'");
  await writeFile(new URL(output, runtime), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText);
}
const { parseMarkdownTable, splitMarkdownTableRow } = await import(new URL('markdown-table.mjs', runtime));
const { default: GuestMarkdown } = await import(new URL('guest-markdown.mjs', runtime));
const render = text => renderToStaticMarkup(createElement(GuestMarkdown, { text }));
const parse = text => parseMarkdownTable(text.split('\n'), 0);

test('standard pipe tables render real headers, aligned cells, and keyboard-accessible scrolling', () => {
  const markdown = '| 이름 | 설명 | 순서 |\n| :--- | :---: | ---: |\n| 첫째 | **굵은 글씨** | 1 |\n| 둘째 | `코드` | 2 |';
  const table = parse(markdown);
  assert.deepEqual(table.headers, ['이름', '설명', '순서']);
  assert.deepEqual(table.alignments, ['left', 'center', 'right']);
  assert.deepEqual(table.rows, [['첫째', '**굵은 글씨**', '1'], ['둘째', '`코드`', '2']]);
  const html = render(markdown);
  assert.match(html, /class="pg-table-scroll" role="region" aria-label="[^"]+" tabindex="0"/);
  assert.equal((html.match(/<th scope="col"/g) || []).length, 3);
  assert.equal((html.match(/<td(?: |>|\/)/g) || []).length, 6);
  assert.match(html, /<th scope="col" style="text-align:right">순서<\/th>/);
  assert.match(html, /<td style="text-align:center"><strong>굵은 글씨<\/strong><\/td>/);
  assert.match(html, /<code>코드<\/code>/);
  assert.doesNotMatch(html, /---/);
});

test('optional outer pipes, one-column tables, and empty cells remain valid', () => {
  assert.deepEqual(parse('Item | Value\n--- | ---\na | b').rows, [['a', 'b']]);
  assert.deepEqual(parse('| Item |\n| --- |\n| a |').rows, [['a']]);
  assert.deepEqual(parse('| A | B | C |\n| - | - | - |\n| a || c |').rows, [['a', '', 'c']]);
  assert.deepEqual(parse('| A | B | C |\n| - | - | - |\n| a |').rows, [['a', '', '']]);
  assert.deepEqual(parse('| A | B |\n| - | - |\n| a | b | excess |').rows, [['a', 'b']]);
});

test('escaped pipes and complete inline code spans never create unintended columns', () => {
  const row = '| a\\|b | \\';
  assert.deepEqual(splitMarkdownTableRow(row).cells, [String.raw`a\|b`, '\\']);
  assert.deepEqual(splitMarkdownTableRow('| `a|b` | ``a`|b`` | c |').cells, ['`a|b`', '``a`|b``', 'c']);
  assert.deepEqual(splitMarkdownTableRow(String.raw`| a\\ | b |`).cells, [String.raw`a\\`, 'b']);
  const html = render('| Text | Code |\n| --- | --- |\n| a\\|b | `c\\|d` |');
  assert.match(html, /<td>a\|b<\/td><td><code>c\|d<\/code><\/td>/);
  assert.match(render('| Text | Code |\n| --- | --- |\n| a | ``c`|d`` |'), /<code>c`\|d<\/code>/);
});

test('tables end before prose, headings, lists, and fenced code without losing following text', () => {
  const prefix = '| A | B |\n| --- | --- |\n| a | b |\n';
  for (const tail of ['Following explanation.', '# Next section', '- A list item', '```text\nkeep | this\n```', '\nFollowing explanation.']) {
    assert.equal(parse(prefix + tail).nextLine, 3);
    const html = render(prefix + tail);
    assert.ok(html.indexOf('</table>') < html.lastIndexOf(tail.includes('```') ? 'keep | this' : tail.replace(/^[-#]\s|^\n/, '')));
  }
  assert.match(render('Introduction.\n' + prefix + 'Summary.'), /<p>Introduction\.<\/p><div class="pg-table-scroll"/);
  assert.match(render(prefix + 'Summary.'), /<\/table><\/div><p>Summary\.<\/p>/);
});

test('invalid and unfinished headers remain readable text, not malformed tables', () => {
  for (const markdown of [
    'A | B', 'A | B\n--- |', 'A | B\n--- | not a separator',
    'Heading\n---', 'A | B\n--- | --- | ---',
  ]) {
    assert.equal(parse(markdown), null, markdown);
    const html = render(markdown);
    assert.doesNotMatch(html, /<table>/);
    assert.ok(html.includes('A | B') || html.includes('Heading'));
  }
});

test('streaming prefixes maintain rectangular semantic rows and retain the same table identity', () => {
  const text = '| Feature | Details | Status |\n| --- | --- | --- |\n| Tables | 한글과 English | Working |\n| Code | `a|b` | Ready |';
  let tableKey;
  for (let length = 1; length <= text.length; length++) {
    const partial = text.slice(0, length);
    const element = GuestMarkdown({ text: partial });
    const table = element.props.children.find(block => block.props.className === 'pg-table-scroll');
    if (!table) continue;
    tableKey ??= table.key;
    assert.equal(table.key, tableKey);
    const html = render(partial);
    for (const row of html.match(/<tr>.*?<\/tr>/g) || []) {
      assert.equal((row.match(/<(?:th|td)(?:\s|>)/g) || []).length, 3);
    }
  }
  assert.equal(tableKey, 'table-0');
  const paragraphBefore = GuestMarkdown({ text: 'A sentence.' }).props.children[0];
  const paragraphAfter = GuestMarkdown({ text: 'A sentence.\nContinued text.' }).props.children[0];
  assert.equal(paragraphBefore.key, paragraphAfter.key);
});

test('tables remain literal inside code fences and Windows line endings parse normally', () => {
  const markdown = '| A | B |\n| --- | --- |\n| a | b |';
  assert.doesNotMatch(render('```markdown\n' + markdown + '\n```'), /<table>/);
  assert.match(render('```markdown\n' + markdown + '\n```'), /<pre><code>\| A \| B \|/);
  assert.doesNotMatch(render('~~~markdown\n' + markdown + '\n~~~'), /<table>/);
  assert.doesNotMatch(render('````markdown\n```\n' + markdown + '\n````'), /<table>/);
  assert.match(render('```text\n```not a closing fence\n```'), /<code>```not a closing fence<\/code>/);
  assert.match(render(markdown.replaceAll('\n', '\r\n')), /<table>/);
  assert.match(render(markdown.replaceAll('\n', '\r')), /<table>/);
});

test('HTML remains escaped, unsafe links remain text, and supported artifact links work', () => {
  const markdown = '| Content | Link |\n| --- | --- |\n| <script>alert(1)</script> | [source](https://example.com/guide) |\n| <img src=x onerror=alert(1)> | [download](/api/artifacts/report-123) |';
  const html = render(markdown);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /href="https:\/\/example.com\/guide" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="\/api\/artifacts\/report-123"/);
  for (const href of ['javascript:alert(1)', '//example.com', '/api/artifacts/../../signout', 'https://user:secret@example.com/', 'https://example.com\\@evil.test/']) {
    assert.doesNotMatch(render('[link](' + href + ')'), /<a\s/, href);
  }
});

test('existing paragraphs, bold text, code, lists, and links still render correctly', () => {
  const html = render('# Heading\n\nA **strong** paragraph with `code` and [source](https://example.com).\n\n- One\n- Two\n\n1. First\n2. Second\n\n```js\nconst answer = 42;\n```');
  assert.match(html, /<h3>Heading<\/h3>/);
  assert.match(html, /<strong>strong<\/strong>/);
  assert.match(html, /<ul><li>One<\/li><li>Two<\/li><\/ul>/);
  assert.match(html, /<ol><li>First<\/li><li>Second<\/li><\/ol>/);
  assert.match(html, /<pre><code>const answer = 42;<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/example.com"/);
  assert.match(render('Escaped \\*asterisk\\* and \\| pipe.'), /Escaped \*asterisk\* and \| pipe\./);
});
