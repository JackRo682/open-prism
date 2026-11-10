import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const runtime = new URL('../.sites-runtime/guest-import-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
for (const name of ['models', 'guest-import']) {
  const source = (await readFile(new URL('../lib/' + name + '.ts', import.meta.url), 'utf8')).replaceAll("'./models'", "'./models.mjs'");
  await writeFile(new URL(name + '.mjs', runtime), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}
const { importGuestConversation, validateGuestImport } = await import(new URL('guest-import.mjs', runtime));
const schema = (await Promise.all(['0000_shallow_tony_stark.sql', '0001_yellow_bishop.sql', '0002_omniscient_sinister_six.sql'].map(name =>
  readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')))).join('\n');

function fixture() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(schema);
  const sql = {
    prepare(query) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return sqlite.prepare(query).get(...values) ?? null; },
        async run() { return { success: true, meta: sqlite.prepare(query).run(...values) }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT'); return results;
      } catch (cause) { sqlite.exec('ROLLBACK'); throw cause; }
    },
  };
  return { sqlite, sql, close() { sqlite.close(); } };
}

test('import keeps legacy and current guest model provenance while choosing free Flash-Lite for continuation', async () => {
  const f = fixture();
  try {
    const body = { sessionId: crypto.randomUUID(), messages: [
      { role: 'user', content: 'Legacy question.' },
      { role: 'assistant', content: 'Old answer without model metadata.' },
      { role: 'user', content: 'Question before the model switch.' },
      { role: 'assistant', content: 'Old Sol answer with model metadata.', model: 'gpt-6.1-sol' },
      { role: 'user', content: 'New free question.' },
      { role: 'assistant', content: 'New Gemini answer.', model: 'gemini-3.5-flash-lite' },
    ] };
    const result = await importGuestConversation(f.sql, 'owner', body);
    assert.equal(result.reused, false);
    const conversation = f.sqlite.prepare('SELECT model,user_id FROM conversations WHERE id=?').get(result.conversationId);
    assert.equal(conversation.model, 'gemini-3.5-flash-lite'); assert.equal(conversation.user_id, 'owner');
    const messages = f.sqlite.prepare('SELECT role,model FROM messages WHERE conversation_id=? ORDER BY created_at').all(result.conversationId);
    assert.deepEqual(messages.map(message => [message.role, message.model]), [
      ['user', null], ['assistant', 'gpt-6.1-sol'],
      ['user', null], ['assistant', 'gpt-6.1-sol'],
      ['user', null], ['assistant', 'gemini-3.5-flash-lite'],
    ]);
    assert.deepEqual(await importGuestConversation(f.sql, 'owner', body), { conversationId: result.conversationId, reused: true });
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM messages').get().n, 6);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM usage').get().n, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wallet_events').get().n, 0);
  } finally { f.close(); }
});

test('guest import accepts only guest-supported assistant provenance and rejects injected fields', () => {
  const body = { sessionId: crypto.randomUUID(), messages: [
    { role: 'user', content: 'Question.' },
    { role: 'assistant', content: 'Answer.', model: 'gemini-3.5-flash-lite' },
  ] };
  for (const model of ['gpt-6-astra', 'claude-fable-5-1', 'gemini-4-argon', '', null, 42, ['gemini-3.5-flash-lite']]) {
    assert.throws(() => validateGuestImport({ ...body, messages: [body.messages[0], { ...body.messages[1], model }] }));
  }
  assert.throws(() => validateGuestImport({ ...body, messages: [{ ...body.messages[0], model: 'gemini-3.5-flash-lite' }, body.messages[1]] }));
  assert.throws(() => validateGuestImport({ ...body, messages: [body.messages[0], { ...body.messages[1], provider: 'google' }] }));
  assert.equal(validateGuestImport(body).messages[1].model, 'gemini-3.5-flash-lite');
  assert.equal(validateGuestImport({ ...body, messages: [body.messages[0], { role: 'assistant', content: 'Legacy answer.' }] }).messages[1].model, 'gpt-6.1-sol');
});
