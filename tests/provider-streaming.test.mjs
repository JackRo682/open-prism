import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import ts from 'typescript';

const directory = new URL('../.sites-runtime/provider-streaming-tests/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const name of ['models', 'provider']) {
  const source = (await readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'))
    .replaceAll("'./models'", "'./models.mjs'");
  await writeFile(new URL(`${name}.mjs`, directory), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}
const { invokeProvider } = await import(new URL('provider.mjs', directory).href);
const { MODELS } = await import(new URL('models.mjs', directory).href);
const google = MODELS.find(model => model.provider === 'google');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const encoder = new TextEncoder();
const frame = event => `event: ${event.event_type || event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
const completed = (usage = { total_input_tokens: 12, total_output_tokens: 20, total_thought_tokens: 3 }, rest = {}) => ({
  event_type: 'interaction.completed', interaction: { status: 'completed', usage, ...rest },
});
const stream = events => new Response(events.map(frame).join('') + 'event: done\r\ndata: [DONE]\r\n\r\n', {
  headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
});
const invoke = (emit = () => {}, signal = new AbortController().signal) => invokeProvider(
  google, 'fixture-key', [{ role: 'user', content: 'Say hello.' }], 'medium', false, signal, emit, 1024,
);

test('Google sends real text before completion, preserves split UTF-8, and omits thought/tool deltas', { timeout: 2000 }, async () => {
  let upstream;
  let resolveFirstText;
  const firstText = new Promise(resolve => { resolveFirstText = resolve; });
  const received = [];
  let finished = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    const request = JSON.parse(options.body);
    assert.equal(request.stream, true);
    assert.equal(request.store, false);
    assert.equal(request.generation_config.max_output_tokens, 1024);
    assert.equal(request.generation_config.thinking_level, 'medium');
    return new Response(new ReadableStream({ start(controller) { upstream = controller; } }), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  const result = invoke(text => { received.push(text); resolveFirstText(); }).then(usage => { finished = true; return usage; });
  upstream.enqueue(encoder.encode(frame({ event_type: 'step.start', index: 0, step: { type: 'thought', summary: [{ type: 'text', text: 'Private thought' }] } })));
  upstream.enqueue(encoder.encode(frame({ event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'Hidden summary' } } })));
  upstream.enqueue(encoder.encode(frame({ event_type: 'step.start', index: 1, step: { type: 'model_output', content: [{ type: 'text', text: '첫 ' }] } })));
  await firstText;
  assert.deepEqual(received, ['첫 ']);
  assert.equal(finished, false, 'the first text must be observable while the upstream is still open');
  const bytes = encoder.encode(frame({ event_type: 'step.delta', index: 1, delta: { type: 'text', text: '번째 🧪 답변' } }));
  const split = bytes.indexOf(0xf0) + 2;
  upstream.enqueue(bytes.slice(0, split));
  upstream.enqueue(bytes.slice(split));
  upstream.enqueue(encoder.encode(frame({ event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: '{"secret":"hidden"}' } })));
  upstream.enqueue(encoder.encode(frame(completed(undefined, { output_text: '첫 번째 🧪 답변' }))));
  upstream.enqueue(encoder.encode('event: done\r\ndata: [DONE]\r\n\r\n'));
  upstream.close();
  assert.deepEqual(await result, { input: 12, output: 23 });
  assert.deepEqual(received, ['첫 ', '번째 🧪 답변'], 'initial text, deltas, and final fallback must not be duplicated');
});

test('Google supports compatible complete JSON responses and terminal-only final text', async () => {
  globalThis.fetch = async () => Response.json({
    status: 'completed', steps: [{ type: 'thought', content: [{ type: 'text', text: 'hidden' }] }, { type: 'model_output', content: [{ type: 'text', text: 'JSON answer' }] }],
    usage: { total_input_tokens: 4, total_output_tokens: 5, total_thought_tokens: 3 },
  });
  const received = [];
  assert.deepEqual(await invoke(text => received.push(text)), { input: 4, output: 8 });
  assert.deepEqual(received, ['JSON answer']);
  globalThis.fetch = async () => stream([completed(undefined, { output_text: 'Terminal answer' })]);
  await invoke(text => received.push(text));
  assert.deepEqual(received, ['JSON answer', 'Terminal answer']);
});

test('Google errors, truncated streams, failed completions, and absent usage cannot become a successful reply', async () => {
  const delta = { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Partial text' } };
  for (const [events, message] of [
    [[delta], /before completing/],
    [[delta, { event_type: 'error', error: { message: 'Private provider diagnostics', code: 'gateway_timeout' } }], /interrupted/],
    [[delta, completed(undefined, { status: 'requires_action' })], /did not complete/],
    [[delta, completed({})], /valid billable usage/],
    [[completed()], /returned no text/],
  ]) {
    globalThis.fetch = async () => stream(events);
    await assert.rejects(() => invoke(), message);
  }
});

test('Google cancellation stops forwarding queued provider events', async () => {
  let cancelled = false;
  const aborter = new AbortController();
  const first = { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'First' } };
  const second = { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Second' } };
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.signal, aborter.signal);
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode([first, second, completed()].map(frame).join(''))); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const received = [];
  await assert.rejects(() => invoke(text => { received.push(text); aborter.abort(); }, aborter.signal), { name: 'AbortError' });
  assert.deepEqual(received, ['First']);
  assert.equal(cancelled, true);
});

test('OpenAI and Anthropic still forward each answer delta without waiting for completion', { timeout: 2000 }, async () => {
  for (const provider of ['openai', 'anthropic']) {
    let upstream;
    let resolveFirst;
    const firstText = new Promise(resolve => { resolveFirst = resolve; });
    const model = MODELS.find(model => model.provider === provider);
    const received = [];
    let finished = false;
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { upstream = controller; } }), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const result = invokeProvider(model, 'fixture-key', [{ role: 'user', content: 'Hi' }], 'medium', false,
      new AbortController().signal, text => { received.push(text); resolveFirst(); }).then(usage => { finished = true; return usage; });
    const first = provider === 'openai'
      ? [{ type: 'response.output_text.delta', delta: 'First ' }]
      : [{ type: 'message_start', message: { usage: { input_tokens: 12 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'First ' } }];
    upstream.enqueue(encoder.encode(first.map(frame).join('')));
    await firstText;
    assert.deepEqual(received, ['First ']);
    assert.equal(finished, false);
    const last = provider === 'openai'
      ? [{ type: 'response.output_text.delta', delta: 'second' }, { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 20 } } }]
      : [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'second' } }, { type: 'message_delta', usage: { output_tokens: 20 }, delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }];
    upstream.enqueue(encoder.encode(last.map(frame).join('')));
    upstream.close();
    assert.deepEqual(await result, { input: 12, output: 20 });
    assert.deepEqual(received, ['First ', 'second']);
  }
});
