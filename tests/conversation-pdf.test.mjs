import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import ts from 'typescript';
import { ensureExportFont } from '../scripts/prepare-export-font.mjs';
ensureExportFont();

const directory = new URL('../.sites-runtime/print-validation/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const name of ['markdown-table', 'conversation-pdf']) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } }).outputText.replace("'./markdown-table'", "'./markdown-table.mjs'");
  await writeFile(new URL(`${name}.mjs`, directory), compiled);
}
const { createConversationPdf, pdfInlineText } = await import(new URL('conversation-pdf.mjs', directory));
const fonts = {
  regular: await readFile(new URL('../public/fonts/prism-export-korean-v1.ttf', import.meta.url)),
  fallback: await readFile(new URL('../public/fonts/DejaVuSans.ttf', import.meta.url)),
};
const cjk = await readFile(new URL('../public/fonts/prism-export-cjk-v1.ttf', import.meta.url));
async function pageCount(bytes) { return (await PDFDocument.load(bytes)).getPageCount(); }

async function assertVisibleSubsetGlyphs(bytes) {
  const doc = await PDFDocument.load(bytes);
  const seen = new Set();
  for (const page of doc.getPages()) {
    const fontResources = page.node.Resources().lookup(PDFName.of('Font'), PDFDict);
    for (const [, ref] of fontResources.entries()) {
      if (seen.has(ref.toString())) continue;
      seen.add(ref.toString());
      const font = doc.context.lookup(ref, PDFDict);
      const descendant = font.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
      const descriptor = descendant.lookup(PDFName.of('FontDescriptor'), PDFDict);
      const file = descriptor.lookup(PDFName.of('FontFile2'), PDFRawStream);
      const subset = fontkit.create(decodePDFRawStream(file).decode());
      const cmap = new TextDecoder().decode(decodePDFRawStream(font.lookup(PDFName.of('ToUnicode'), PDFRawStream)).decode());
      for (const [, cid, unicode] of cmap.matchAll(/^<([\dA-F]+)> <([\dA-F]+)>$/gm)) {
        const text = String.fromCharCode(...unicode.match(/.{4}/g).map(value => parseInt(value, 16)));
        if (!/[\p{L}\p{N}]/u.test(text)) continue;
        // Extraction alone cannot catch corrupt glyph offsets: the Unicode map
        // can be valid even when a PDF viewer renders the font as blank spaces.
        assert.ok(subset.getGlyph(parseInt(cid, 16)).path.commands.length > 0,
          `The embedded outline for ${JSON.stringify(text)} must be drawable`);
      }
    }
  }
}

test('short Korean conversation exports one real PDF page', async () => {
  const input = { title: '한국어 대화 검증', messages: [
    { role: 'user', content: '안녕하세요. 짧은 대화를 PDF로 저장해 주세요.' },
    { role: 'assistant', content: '## 확인 결과\n\n짧은 답변은 한 페이지에 저장됩니다.\n\n**PRISM_PDF_END_SHORT**' },
  ] };
  const bytes = await createConversationPdf(input, fonts);
  assert.match(new TextDecoder().decode(bytes.slice(0, 8)), /^%PDF-/);
  assert.equal(await pageCount(bytes), 1);
  await assertVisibleSubsetGlyphs(bytes);
  await writeFile(new URL('short-conversation.pdf', directory), bytes);
});

test('exact page boundary and final whitespace do not create a trailing page', async () => {
  const content = Array.from({ length: 37 }, (_, i) => `Line ${i + 1}`).join('\n');
  const input = { title: 'Boundary', messages: [{ role: 'user', content }] };
  // Header/author occupy 86.05pt; 37 body lines occupy 671.55pt. With 42pt
  // top/bottom margins an 841.60pt page fits exactly, down to the final line.
  assert.equal(await pageCount(await createConversationPdf(input, fonts, [595.28, 841.60])), 1);
  assert.equal(await pageCount(await createConversationPdf(input, fonts, [595.28, 841.58])), 2);
  const trailing = { ...input, messages: [{ role: 'user', content: content + '\n'.repeat(100) }] };
  assert.equal(await pageCount(await createConversationPdf(trailing, fonts, [595.28, 841.60])), 1);
  const emptyFence = { ...input, messages: [{ role: 'assistant', content: content + '\n\n```\n```' }] };
  assert.equal(await pageCount(await createConversationPdf(emptyFence, fonts, [595.28, 841.60])), 1);
});

test('long Korean prose, table rows, unbroken values and code paginate with all content', async () => {
  const paragraphs = Array.from({ length: 14 }, (_, index) => `### 구간 ${index + 1}\n\n${'긴 한국어 대화는 화면 높이와 관계없이 모든 내용이 문서에 보존되어야 합니다. '.repeat(5)}SECTION_END_${index + 1}`).join('\n\n');
  const table = ['| 항목 | 한국어 설명 | 긴 영문 값 | 마지막 열 |', '| --- | --- | --- | --- |',
    ...Array.from({ length: 14 }, (_, i) => `| ${i + 1} | 표의 내용을 읽을 수 있어야 합니다. ${'아주 긴 표 셀도 여러 페이지에 걸쳐 빠짐없이 이어져야 합니다. '.repeat(i === 7 ? 110 : 1)} | ${'abcdefghijklmnopqrstuvwxyz'.repeat(3)} | TABLE_END_${i + 1} |`)].join('\n');
  const code = '```typescript\n' + Array.from({ length: 40 }, (_, i) => `const line${i + 1} = "한국어 코드 및 매우 긴 값 ${'abcdefghijklmnopqrstuvwxyz'.repeat(4)}";`).join('\n') + '\nconst CODE_END = "PRISM_PDF_CODE_END";\n```';
  const input = { title: '긴 대화 PDF 검증', messages: [
    { role: 'user', content: '긴 대화와 표, 코드의 마지막 부분까지 저장해 주세요.' },
    { role: 'assistant', content: paragraphs + '\n\n' + table + '\n\n' + code + '\n\nPRISM_PDF_END_LONG' },
  ] };
  const bytes = await createConversationPdf(input, fonts);
  assert.ok(await pageCount(bytes) > 2);
  await writeFile(new URL('long-conversation.pdf', directory), bytes);
});

test('full CJK and extended Unicode remain text in a PDF', async () => {
  const input = { title: '다국어 Unicode 검증', messages: [
    { role: 'user', content: '한국어 English 日本語 中文 é Ω Ж → ≤ ₩ 😀' },
    { role: 'assistant', content: '한국어와 日本語, 中文 및 기호 Ω ≤ →도 보존합니다.\n\nPRISM_PDF_END_UNICODE' },
  ] };
  const bytes = await createConversationPdf(input, { ...fonts, regular: cjk });
  assert.equal(await pageCount(bytes), 1);
  await assertVisibleSubsetGlyphs(bytes);
  await writeFile(new URL('unicode-conversation.pdf', directory), bytes);
});

test('wide tables are preserved as readable labeled rows', async () => {
  const headers = Array.from({ length: 10 }, (_, i) => `열 ${i + 1}`);
  const table = `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n| ${headers.map((_, i) => `VALUE_${i + 1}`).join(' | ')} |`;
  const bytes = await createConversationPdf({ title: 'Wide table', messages: [{ role: 'assistant', content: table }] }, fonts);
  assert.equal(await pageCount(bytes), 1);
});

test('missing glyphs fail explicitly when no rendering fallback is supplied', async () => {
  await assert.rejects(createConversationPdf({ title: 'Unsupported', messages: [{ role: 'user', content: '🧪' }] }, fonts), /U\+1F9EA/);
});

test('empty conversations are not exported as an empty PDF', async () => {
  await assert.rejects(createConversationPdf({ title: 'Empty', messages: [{ role: 'assistant', content: '  \n' }] }, fonts), /대화가 없습니다/);
});

test('inline conversion keeps code contents, escaped characters, and link destinations', () => {
  assert.equal(pdfInlineText('**bold** and `a|b` [문서](https://example.com/a) \\*literal\\*'), 'bold and a|b 문서 (https://example.com/a) *literal*');
});
