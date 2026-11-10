import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const directory = new URL('../.sites-runtime/chat-stream-tests/', import.meta.url);
await mkdir(directory, { recursive: true });
const source = await readFile(new URL('../lib/chat-stream.ts', import.meta.url), 'utf8');
await writeFile(new URL('chat-stream.mjs', directory), ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const { createChatTextPacer, readChatStream } = await import(new URL('chat-stream.mjs', directory));

function fakeClock() {
  let time = 0, sequence = 0, hidden = false, frame = 0;
  const frames = new Map(), timers = new Map(), listeners = new Set();
  const clock = {
    now: () => time,
    hidden: () => hidden,
    frame(callback) { const id = ++sequence; frames.set(id, callback); return () => frames.delete(id); },
    delay(callback, ms) { const id = ++sequence; timers.set(id, { callback, due: time + ms }); return () => timers.delete(id); },
    onVisibilityChange(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    step(ms = 16) {
      time += ms;
      if (!hidden) {
        frame++;
        const pending = [...frames]; frames.clear();
        for (const [, callback] of pending) callback();
      }
      const pending = [...timers].filter(([, timer]) => timer.due <= time);
      for (const [id, timer] of pending) { timers.delete(id); timer.callback(); }
    },
    setHidden(value) { hidden = value; for (const listener of listeners) listener(); },
    get frameNumber() { return frame; },
    get queued() { return frames.size + timers.size; },
    get listenerCount() { return listeners.size; },
  };
  return clock;
}

async function microtasks() { for (let i = 0; i < 16; i++) await Promise.resolve(); }

async function drive(promise, clock) {
  let settled = false, error;
  promise.then(() => { settled = true; }, cause => { settled = true; error = cause; });
  for (let i = 0; i < 300 && !settled; i++) {
    await microtasks();
    if (!settled) clock.step();
  }
  await microtasks();
  assert.equal(settled, true, 'the stream must settle without real-time waits');
  if (error) throw error;
}

const event = data => `data: ${JSON.stringify(data)}\n\n`;
function streamResponse(chunks, { open = false, contentType = 'text/event-stream; charset=utf-8' } = {}) {
  let index = 0, cancelled = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index++];
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      } else if (!open) controller.close();
    },
    cancel() { cancelled++; },
  });
  return { response: new Response(body, { headers: { 'Content-Type': contentType } }), get cancelled() { return cancelled; } };
}

function recorder(clock, effect) {
  let text = '';
  const events = [];
  return {
    events,
    get text() { return text; },
    onEvent(value) {
      if (value.type === 'delta') text += value.text;
      if (value.type === 'replace') text = value.text;
      events.push({ ...value, rendered: text, frame: clock.frameNumber, time: clock.now() });
      effect?.(value);
    },
  };
}

test('one buffered network chunk is revealed across frames before done and settles within one second', async () => {
  const clock = fakeClock(), output = recorder(clock);
  const answer = 'A clear response with several sentences. '.repeat(50);
  const input = streamResponse([event({ type: 'start', conversationId: 'test' }) + event({ type: 'delta', text: answer }) + event({ type: 'done', usage: { output: 20 } })], { open: true });
  const reading = readChatStream(input.response, { signal: new AbortController().signal, onEvent: output.onEvent, clock });
  await microtasks();
  assert.equal(output.events[0].type, 'start');
  assert.ok(output.text.length > 0 && output.text.length < answer.length);
  assert.equal(output.events.some(value => value.type === 'done'), false);
  await drive(reading, clock);
  assert.equal(output.text, answer);
  const textEvents = output.events.filter(value => value.type === 'delta');
  const done = output.events.at(-1);
  assert.equal(done.type, 'done');
  assert.ok(textEvents.length > 10);
  assert.ok(done.frame > textEvents.at(-1).frame, 'completion must follow the final text frame');
  assert.ok(done.time <= 1000, 'a buffered answer should catch up promptly');
  assert.equal(input.cancelled, 1, 'a done event terminates even a transport left open by the server');
  assert.equal(input.response.body.locked, false);
  assert.equal(clock.queued, 0);
  assert.equal(clock.listenerCount, 0);
});

test('many tiny provider deltas in a single read do not batch into the full answer', async () => {
  const clock = fakeClock(), output = recorder(clock);
  const answer = 'abcdefghij'.repeat(30);
  const input = streamResponse([[...answer].map(text => event({ type: 'delta', text })).join('') + event({ type: 'done' })]);
  const reading = readChatStream(input.response, { signal: new AbortController().signal, onEvent: output.onEvent, clock });
  await microtasks();
  assert.ok(output.text.length > 0 && output.text.length < 20, 'only the initial prefix may be synchronous');
  await drive(reading, clock);
  assert.equal(output.text, answer);
  assert.ok(new Set(output.events.filter(item => item.type === 'delta').map(item => item.frame)).size > 5);
});

test('UTF-8, CRLF, lone CR, comments, multi-data lines and final unterminated done are parsed', async () => {
  const clock = fakeClock(), output = recorder(clock);
  const source = ': keepalive\r\nevent: message\r\ndata:{"type":"start","conversationId":"unicode"}\r\n\r\n'
    + 'data: {"type":"delta",\r\ndata: "text":"한국어 👩🏽‍💻"}\r\n\r\n'
    + 'data:{"type":"delta","text":" 답변"}\r\r'
    + 'data: {"type":"done"}';
  const bytes = new TextEncoder().encode(source);
  const chunks = Array.from({ length: bytes.length }, (_, index) => bytes.slice(index, index + 1));
  const input = streamResponse(chunks);
  await drive(readChatStream(input.response, { signal: new AbortController().signal, onEvent: output.onEvent, clock }), clock);
  assert.equal(output.text, '한국어 👩🏽‍💻 답변');
  assert.equal(output.events[0].type, 'start');
  assert.equal(output.events.at(-1).type, 'done');
  assert.equal(input.response.body.locked, false);
});

test('grapheme pacing never displays half of a complete emoji, flag or combining sequence', async () => {
  const clock = fakeClock(), output = recorder(clock);
  const answer = '👩🏽‍💻🇰🇷e\u0301👨‍👩‍👧‍👦한글'.repeat(12);
  const boundaries = new Set([0, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(answer), item => item.index + item.segment.length)]);
  const pacer = createChatTextPacer({ onEvent: output.onEvent, clock });
  pacer.push({ type: 'delta', text: answer });
  await drive(pacer.finish({ type: 'done' }), clock);
  for (const item of output.events.filter(item => item.type === 'delta')) assert.ok(boundaries.has(item.rendered.length));
  assert.equal(output.text, answer);
});

test('a canonical replacement preserves only the shown common prefix and discards obsolete pending text', async () => {
  const clock = fakeClock(), output = recorder(clock);
  const pacer = createChatTextPacer({ onEvent: output.onEvent, clock });
  pacer.push({ type: 'delta', text: 'The original answer without citations. '.repeat(20) });
  for (let i = 0; i < 5; i++) clock.step();
  const canonical = 'The [verified source](https://example.com) provides this answer. '.repeat(14);
  const before = output.text;
  pacer.push({ type: 'replace', text: canonical });
  assert.equal(output.text, 'The ');
  assert.ok(before.length > output.text.length);
  assert.equal(output.events.at(-1).type, 'replace');
  assert.ok(output.text.length < canonical.length, 'replacement must not dump its pending backlog');
  await drive(pacer.finish({ type: 'done' }), clock);
  assert.equal(output.text, canonical);
  assert.equal(output.text.includes('original answer'), false);
});

test('shorter, identical and empty canonical replacements produce exact final text', async () => {
  for (const canonical of ['A short answer.', 'A long answer. '.repeat(8), '']) {
    const clock = fakeClock(), output = recorder(clock);
    const pacer = createChatTextPacer({ onEvent: output.onEvent, clock });
    pacer.push({ type: 'delta', text: 'A long answer. '.repeat(8) });
    for (let i = 0; i < 80; i++) clock.step();
    pacer.push({ type: 'replace', text: canonical });
    await drive(pacer.finish({ type: 'done' }), clock);
    assert.equal(output.text, canonical);
    assert.equal(clock.queued, 0);
  }
});

test('abort flushes accepted queued text once, rejects, cancels the reader and leaves no callbacks', async () => {
  const clock = fakeClock(), output = recorder(clock), controller = new AbortController();
  const answer = 'Text accepted before the user pressed Stop. '.repeat(10);
  const input = streamResponse([event({ type: 'delta', text: answer })], { open: true });
  const reading = readChatStream(input.response, { signal: controller.signal, onEvent: output.onEvent, clock });
  await microtasks();
  assert.ok(output.text.length < answer.length);
  controller.abort();
  await assert.rejects(reading, error => error.name === 'AbortError');
  assert.equal(output.text, answer);
  assert.equal(output.events.filter(item => item.type === 'replace').length, 1);
  assert.equal(output.events.some(item => item.type === 'done'), false);
  const count = output.events.length;
  for (let i = 0; i < 80; i++) clock.step();
  await microtasks();
  assert.equal(output.events.length, count);
  assert.equal(input.cancelled, 1);
  assert.equal(input.response.body.locked, false);
  assert.equal(clock.queued, 0);
  assert.equal(clock.listenerCount, 0);
});

test('server error and missing done preserve partial received text and reject without completion', async () => {
  for (const tail of [event({ type: 'error', error: 'Provider unavailable' }), '']) {
    const clock = fakeClock(), output = recorder(clock);
    const answer = 'A partially generated answer. '.repeat(10);
    const input = streamResponse([event({ type: 'delta', text: answer }) + tail]);
    const reading = readChatStream(input.response, { signal: new AbortController().signal, onEvent: output.onEvent, clock });
    await assert.rejects(reading);
    assert.equal(output.text, answer);
    assert.equal(output.events.some(item => item.type === 'done'), false);
    assert.equal(clock.queued, 0);
    assert.equal(clock.listenerCount, 0);
    assert.equal(input.response.body.locked, false);
  }
});

test('hidden tabs drain queued text and complete even when animation frames are suspended', async () => {
  const clock = fakeClock(), output = recorder(clock);
  const answer = 'A hidden tab can still finish receiving its answer. '.repeat(30);
  const input = streamResponse([event({ type: 'delta', text: answer }) + event({ type: 'done' })]);
  const reading = readChatStream(input.response, { signal: new AbortController().signal, onEvent: output.onEvent, clock });
  await microtasks();
  const initialFrame = clock.frameNumber;
  clock.setHidden(true);
  await drive(reading, clock);
  assert.equal(clock.frameNumber, initialFrame);
  assert.equal(output.text, answer);
  assert.equal(output.events.at(-1).type, 'done');
  assert.equal(clock.queued, 0);
  assert.equal(clock.listenerCount, 0);
});

test('reduced motion avoids the reveal animation while keeping done after the synchronous text paint', async () => {
  const clock = fakeClock(), output = recorder(clock);
  const answer = 'A response with reduced motion. '.repeat(20);
  const input = streamResponse([event({ type: 'delta', text: answer }) + event({ type: 'done' })]);
  const reading = readChatStream(input.response, { signal: new AbortController().signal, onEvent: output.onEvent, reducedMotion: true, clock });
  await microtasks();
  assert.equal(output.text, answer);
  assert.equal(output.events.some(item => item.type === 'done'), false);
  await drive(reading, clock);
  assert.equal(output.events.filter(item => item.type === 'delta').length, 1);
  assert.ok(output.events.at(-1).frame >= 2);
  assert.equal(clock.queued, 0);
});

test('invalid events, oversized buffering and invalid UTF-8 reject and release the stream', async () => {
  const bad = [
    'data: invalid JSON\n\n',
    event([]),
    event({ text: 'missing type' }),
    event({ type: 'delta', text: 123 }),
    event({ type: 'replace', text: null }),
    'data: ' + 'x'.repeat(2_000_001),
    new Uint8Array([0xff]),
  ];
  for (const body of bad) {
    const clock = fakeClock(), output = recorder(clock), input = streamResponse([body], { open: true });
    await assert.rejects(readChatStream(input.response, { signal: new AbortController().signal, onEvent: output.onEvent, clock }));
    assert.equal(output.events.length, 0);
    assert.equal(input.cancelled, 1);
    assert.equal(input.response.body.locked, false);
    assert.equal(clock.queued, 0);
    assert.equal(clock.listenerCount, 0);
  }
});

test('wrong content type and pre-aborted requests cancel without invoking callbacks', async () => {
  for (const preAborted of [false, true]) {
    const clock = fakeClock(), output = recorder(clock), controller = new AbortController();
    if (preAborted) controller.abort();
    const input = streamResponse(['not an SSE response'], { open: true, contentType: 'application/json' });
    await assert.rejects(readChatStream(input.response, { signal: controller.signal, onEvent: output.onEvent, clock }));
    assert.equal(output.events.length, 0);
    assert.equal(input.cancelled, 1);
    assert.equal(input.response.body.locked, false);
    assert.equal(clock.listenerCount, 0);
  }
});

test('a consumer callback error cancels scheduled work and never calls back after rejection', async () => {
  const clock = fakeClock();
  let callbacks = 0;
  const input = streamResponse([event({ type: 'delta', text: 'A long response. '.repeat(100) })], { open: true });
  const reading = readChatStream(input.response, {
    signal: new AbortController().signal,
    clock,
    onEvent() { callbacks++; if (callbacks >= 2) throw new Error('consumer failed'); },
  });
  await microtasks();
  clock.step();
  await assert.rejects(reading, /consumer failed/);
  const count = callbacks;
  for (let i = 0; i < 20; i++) clock.step();
  assert.equal(callbacks, count);
  assert.equal(input.cancelled, 1);
  assert.equal(clock.queued, 0);
  assert.equal(clock.listenerCount, 0);
});
