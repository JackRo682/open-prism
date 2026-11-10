export type ChatStreamEvent = { type: string; text?: string; [key: string]: any };

/** Scheduling is injectable so stream ordering can be tested without real timers. */
export interface ChatStreamClock {
  now(): number;
  frame(callback: () => void): () => void;
  delay(callback: () => void, milliseconds: number): () => void;
  hidden(): boolean;
  onVisibilityChange?(callback: () => void): () => void;
}

export type ChatStreamOptions = {
  signal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
  reducedMotion?: boolean;
  clock?: ChatStreamClock;
};

const MAX_EVENT_SIZE = 2_000_000;
const MAX_ANSWER_SIZE = 2_000_000;
const CATCH_UP_MS = 800;
const MIN_GRAPHEMES_PER_SECOND = 120;

function browserClock(): ChatStreamClock {
  return {
    now: () => performance.now(),
    frame(callback) {
      if (typeof requestAnimationFrame === 'function') {
        const id = requestAnimationFrame(callback);
        return () => cancelAnimationFrame(id);
      }
      const id = setTimeout(callback, 16);
      return () => clearTimeout(id);
    },
    delay(callback, milliseconds) {
      const id = setTimeout(callback, milliseconds);
      return () => clearTimeout(id);
    },
    hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    onVisibilityChange(callback) {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
  };
}

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;

function graphemeEnds(text: string, offset = 0): number[] {
  // A legacy browser without Segmenter keeps an entire supplied cluster intact
  // rather than slicing through a surrogate pair, combining mark, or ZWJ emoji.
  if (!segmenter) return text ? [offset + text.length] : [];
  return Array.from(segmenter.segment(text), item => offset + item.index + item.segment.length);
}

function firstEndAfter(ends: number[], position: number): number {
  let left = 0, right = ends.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (ends[middle] <= position) left = middle + 1;
    else right = middle;
  }
  return left;
}

export interface ChatTextPacer {
  push(event: ChatStreamEvent): void;
  finish(event: ChatStreamEvent): Promise<void>;
  interrupt(error: unknown): void;
  dispose(): void;
  readonly failure: Promise<never>;
}

/**
 * Keep transport delivery independent from visual delivery. A proxy may deliver
 * many provider deltas in one read; only the first small prefix is synchronous.
 * Later prefixes are committed on separate frames, and completion follows a
 * paint opportunity after the last text update.
 */
export function createChatTextPacer(options: {
  onEvent: (event: ChatStreamEvent) => void;
  reducedMotion?: boolean;
  clock?: ChatStreamClock;
}): ChatTextPacer {
  const clock = options.clock ?? browserClock();
  let target = '', shown = '';
  let ends: number[] = [];
  let showedFirstPrefix = false;
  let closed = false;
  let stoppedWith: unknown;
  let terminal: ChatStreamEvent | undefined;
  let deadline = 0, lastTick = clock.now();
  // Synchronous updates need two frame boundaries; an update inside a frame
  // only needs the next one. This prevents a fast done event batching it away.
  let paintFrames = 0;
  let cancelScheduled: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let resolveCompletion!: () => void, rejectCompletion!: (error: unknown) => void;
  let rejectFailure!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  // Either may reject before the reader gets to await it (for example a user
  // stops during a synchronous onEvent callback). Neither is left unobserved.
  void completion.catch(() => {});
  void failure.catch(() => {});

  function clean() {
    cancelScheduled?.();
    cancelScheduled = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
  }

  function interrupt(error: unknown) {
    if (closed) return;
    closed = true;
    stoppedWith = error;
    clean();
    // Keep all text actually accepted from the provider, including text that
    // was still queued for presentation. Never manufacture a completion event.
    if (shown !== target) {
      shown = target;
      try { options.onEvent({ type: 'replace', text: target }); } catch { /* Preserve the original stream failure. */ }
    }
    rejectCompletion(error);
    rejectFailure(error);
  }

  function publish(end: number, inFrame: boolean) {
    if (closed || end <= shown.length) return;
    const text = target.slice(shown.length, end);
    shown = target.slice(0, end);
    showedFirstPrefix = true;
    paintFrames = inFrame ? 1 : 2;
    options.onEvent({ type: 'delta', text });
  }

  function complete() {
    if (closed || !terminal) return;
    const event = terminal;
    options.onEvent(event);
    // onEvent can synchronously abort its own request.
    if (closed) return;
    closed = true;
    clean();
    resolveCompletion();
  }

  function schedule() {
    if (closed || cancelScheduled || (shown === target && paintFrames === 0 && !terminal)) return;
    cancelScheduled = clock.hidden() ? clock.delay(tick, 0) : clock.frame(tick);
  }

  function tick() {
    cancelScheduled = undefined;
    if (closed) return;
    try {
      const now = clock.now();
      if (clock.hidden()) {
        publish(target.length, false);
        paintFrames = 0;
        if (terminal) complete();
      } else if (shown !== target) {
        const from = firstEndAfter(ends, shown.length);
        const remaining = ends.length - from;
        const milliseconds = Math.max(1, now - lastTick);
        const untilDeadline = Math.max(1, deadline - now);
        const rate = Math.max(MIN_GRAPHEMES_PER_SECOND, remaining * 1000 / untilDeadline);
        const count = now >= deadline ? remaining : Math.max(1, Math.ceil(rate * milliseconds / 1000));
        publish(ends[Math.min(ends.length - 1, from + count - 1)], true);
      } else {
        paintFrames = Math.max(0, paintFrames - 1);
        if (terminal && paintFrames === 0) complete();
      }
      lastTick = now;
      schedule();
    } catch (error) { interrupt(error); }
  }

  function queueText(event: ChatStreamEvent) {
    const text = event.text!;
    const hadPending = shown !== target;
    if (event.type === 'delta') {
      if (target.length + text.length > MAX_ANSWER_SIZE) throw new Error('응답이 표시 가능한 크기를 초과했습니다.');
      // Re-segment only the previous trailing cluster plus the appended text.
      // This also joins combining marks or ZWJ sequences crossing event edges.
      const tailStart = ends.length > 1 ? ends[ends.length - 2] : 0;
      const tail = target.slice(tailStart) + text;
      target += text;
      if (ends.length) ends.pop();
      for (const end of graphemeEnds(tail, tailStart)) ends.push(end);
    } else {
      if (text.length > MAX_ANSWER_SIZE) throw new Error('응답이 표시 가능한 크기를 초과했습니다.');
      target = text;
      ends = graphemeEnds(target);
      let common = 0;
      while (common < shown.length && common < target.length && shown[common] === target[common]) common++;
      // An authoritative response may insert citations into text already shown.
      // Retain its valid common prefix, discard the obsolete queued suffix,
      // then progressively reveal the canonical replacement from that point.
      if (common < shown.length) {
        const boundary = firstEndAfter(ends, common) - 1;
        common = boundary >= 0 ? ends[boundary] : 0;
        shown = target.slice(0, common);
        paintFrames = 2;
        options.onEvent({ ...event, text: shown });
      }
    }
    if (closed) return;
    const now = clock.now();
    if (!hadPending || now >= deadline || event.type === 'replace') {
      deadline = now + CATCH_UP_MS;
      lastTick = now;
    }
    if (options.reducedMotion || clock.hidden()) {
      publish(target.length, false);
      if (clock.hidden()) paintFrames = 0;
    } else if (!showedFirstPrefix && target) {
      publish(ends[Math.min(7, ends.length - 1)], false);
    }
    schedule();
  }

  unsubscribe = clock.onVisibilityChange?.(() => {
    if (closed) return;
    // A frame scheduled while visible would otherwise remain suspended after
    // the tab becomes hidden. Replace it with a timer and drain off-screen.
    cancelScheduled?.();
    cancelScheduled = undefined;
    schedule();
  });

  return {
    failure,
    push(event) {
      if (closed) { if (stoppedWith) throw stoppedWith; return; }
      try {
        if (event.type === 'delta' || event.type === 'replace') queueText(event);
        else options.onEvent(event);
      } catch (error) { interrupt(error); throw error; }
    },
    finish(event) {
      if (!closed && !terminal) {
        terminal = event;
        try {
          if (shown === target && paintFrames === 0) complete();
          else schedule();
        } catch (error) { interrupt(error); }
      }
      return completion;
    },
    interrupt,
    dispose() { closed = true; clean(); },
  };
}

function parseEvent(data: string): ChatStreamEvent {
  let value: unknown;
  try { value = JSON.parse(data); }
  catch { throw new Error('응답 스트림의 형식이 올바르지 않습니다.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof (value as ChatStreamEvent).type !== 'string'
    || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test((value as ChatStreamEvent).type)) {
    throw new Error('응답 스트림에 올바르지 않은 이벤트가 포함되어 있습니다.');
  }
  const event = value as ChatStreamEvent;
  if ((event.type === 'delta' || event.type === 'replace') && typeof event.text !== 'string') {
    throw new Error('응답 스트림에 올바르지 않은 텍스트가 포함되어 있습니다.');
  }
  return event;
}

function eventParser(accept: (event: ChatStreamEvent) => boolean) {
  let pendingLine = '';
  let data: string[] = [];
  let size = 0;
  let stopped = false;
  function dispatch() {
    if (!data.length) return;
    const raw = data.join('\n');
    data = []; size = 0;
    stopped = !accept(parseEvent(raw));
  }
  function line(value: string) {
    if (value.length > MAX_EVENT_SIZE) throw new Error('응답 스트림의 이벤트가 너무 큽니다.');
    if (!value) { dispatch(); return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    if (field !== 'data') return;
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    size += content.length + 1;
    if (size > MAX_EVENT_SIZE) throw new Error('응답 스트림의 이벤트가 너무 큽니다.');
    data.push(content);
  }
  return (chunk: string, final = false) => {
    if (stopped) return;
    const text = pendingLine + chunk;
    pendingLine = '';
    let start = 0;
    for (let index = 0; index < text.length && !stopped; index++) {
      const char = text[index];
      if (char !== '\n' && char !== '\r') continue;
      if (char === '\r' && index === text.length - 1 && !final) break;
      line(text.slice(start, index));
      if (char === '\r' && text[index + 1] === '\n') index++;
      start = index + 1;
    }
    if (stopped) return;
    pendingLine = text.slice(start);
    if (pendingLine.length > MAX_EVENT_SIZE) throw new Error('응답 스트림의 이벤트가 너무 큽니다.');
    if (final) {
      if (pendingLine) line(pendingLine);
      pendingLine = '';
      if (!stopped) dispatch();
    }
  };
}

function abortError(): DOMException {
  return new DOMException('The response was stopped.', 'AbortError');
}

/** Read one server-sent chat response, releasing both transport and UI work. */
export async function readChatStream(response: Response, options: ChatStreamOptions): Promise<void> {
  try {
    if (options.signal.aborted) throw abortError();
    if (!response.ok) throw new Error('서버에 연결하지 못했습니다.');
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream') {
      throw new Error('서버가 올바른 응답 스트림을 반환하지 않았습니다.');
    }
    if (!response.body) throw new Error('서버가 빈 응답을 반환했습니다.');
  } catch (error) {
    if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
    throw error;
  }
  const reader = response.body!.getReader();
  const pacer = createChatTextPacer({
    onEvent: options.onEvent,
    clock: options.clock,
    reducedMotion: options.reducedMotion ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches),
  });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let doneEvent: ChatStreamEvent | undefined;
  let cancelled = false;
  function cancelReader() {
    if (cancelled) return;
    cancelled = true;
    // Do not let a non-responsive upstream cancellation delay Stop/cleanup.
    void reader.cancel().catch(() => {});
  }
  const onAbort = () => { pacer.interrupt(abortError()); cancelReader(); };
  options.signal.addEventListener('abort', onAbort, { once: true });
  const feed = eventParser(event => {
    if (event.type === 'error') throw new Error(typeof event.error === 'string' ? event.error : '답변 생성이 중단되었습니다. 다시 시도해 주세요.');
    if (event.type === 'done') { doneEvent = event; return false; }
    pacer.push(event);
    return true;
  });
  try {
    if (options.signal.aborted) throw abortError();
    while (!doneEvent) {
      const chunk = await Promise.race([reader.read(), pacer.failure]);
      if (options.signal.aborted) throw abortError();
      feed(decoder.decode(chunk.value, { stream: !chunk.done }), chunk.done);
      if (chunk.done) break;
    }
    if (!doneEvent) throw new Error('응답이 완료되기 전에 연결이 종료되었습니다.');
    cancelReader();
    await pacer.finish(doneEvent);
    if (options.signal.aborted) throw abortError();
  } catch (error) {
    pacer.interrupt(error);
    cancelReader();
    throw error;
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    pacer.dispose();
    reader.releaseLock();
  }
}
