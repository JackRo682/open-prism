import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import { invocationSchema, driverMessageSchema, sessionOptionsSchema } from '../scripts/connector-preview/protocol.mjs';

const runtime = new URL('../.sites-runtime/connector-security-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
await writeFile(new URL('connector-errors.mjs', runtime), ts.transpileModule(
  await readFile(new URL('../lib/connector-errors.mts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText);
const { connectorResponse } = await import(new URL('connector-errors.mjs', runtime));

test('patched Zod validates real connector invocation records without widening permissions', () => {
  const valid = { connectorId: 'drive', actionName: 'read', arguments: { id: 'document', nested: { count: 1 } } };
  assert.deepEqual(invocationSchema.parse(valid), valid);
  for (const invalid of [{ ...valid, accountId: 'another-account' }, { ...valid, tool: 'native-admin' }, { ...valid, connectorId: '../drive' }, { ...valid, arguments: ['not-a-record'] }]) {
    assert.equal(invocationSchema.safeParse(invalid).success, false);
  }
});

test('patched Zod keeps JSON-RPC records and session limits strict', () => {
  const valid = { jsonrpc: '2.0', id: crypto.randomUUID(), result: { status: 'success' } };
  assert.deepEqual(driverMessageSchema.parse(valid), valid);
  assert.equal(driverMessageSchema.safeParse({ ...valid, result: [] }).success, false);
  assert.equal(driverMessageSchema.safeParse({ ...valid, untrusted: true }).success, false);
  assert.deepEqual(driverMessageSchema.parse({ jsonrpc: '2.0', method: 'stop' }), { jsonrpc: '2.0', method: 'stop' });
  assert.equal(sessionOptionsSchema.safeParse({ maxCalls: -1 }).success, false);
  assert.equal(sessionOptionsSchema.safeParse({ timeoutMs: 2 ** 31 }).success, false);
});

test('connector response validation preserves successful results and rejects diagnostic envelopes', async () => {
  const response = connectorResponse({ status: 'success', result: { content: [{ type: 'text', text: 'Verified result.' }] }, requestId: 'request-123', token: 'must-not-escape' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).token, undefined);
  const invalid = connectorResponse({ status: 'success', result: { content: [{ type: 'text', text: 'data' }] }, error: { secret: 'must-not-escape' } });
  assert.equal(invalid.status, 502);
  assert.doesNotMatch(await invalid.text(), /must-not-escape/);
});
