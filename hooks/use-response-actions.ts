'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechPlayback = {
  cancel(): void;
};

// Speech synthesis is a single browser-wide queue. This is only assigned in
// browser event handlers, never while rendering or processing a server request.
let activePlayback: SpeechPlayback | null = null;

/** Read the answer's words without announcing Markdown delimiters or link URLs. */
export function responseTextForSpeech(content: string): string {
  return content
    .replace(/^\s*(`{3,}|~{3,})[^\n]*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+)/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_\n]+)_{1,3}/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/\|/g, ', ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Short utterances avoid browsers cutting off a long response mid-sentence. */
export function splitSpeechText(text: string, maxLength = 220): string[] {
  maxLength = Number.isFinite(maxLength) ? Math.max(32, Math.floor(maxLength)) : 220;
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxLength) {
    const prefix = remaining.slice(0, maxLength);
    const sentenceEnds = [...prefix.matchAll(/[.!?。！？](?:\s|$)/g)];
    const lastSentence = sentenceEnds.at(-1);
    const sentenceEnd = lastSentence ? lastSentence.index + 1 : -1;
    const lastSpace = prefix.lastIndexOf(' ');
    let cut = sentenceEnd >= maxLength / 2 ? sentenceEnd : lastSpace >= maxLength / 2 ? lastSpace : maxLength;
    // Never divide a UTF-16 surrogate pair (emoji and some ideographs).
    if (/[\uD800-\uDBFF]/.test(remaining[cut - 1])) cut--;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function speechLanguage(text: string): string {
  if (/[가-힣]/.test(text)) return 'ko-KR';
  if (/[ぁ-んァ-ン]/.test(text)) return 'ja-JP';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh-CN';
  if (/[A-Za-z]/.test(text)) return 'en-US';
  return navigator.language || 'ko-KR';
}

export type ResponseListeningOptions = {
  scope: string;
  messageId: string;
  content: string;
  onError?(message: string): void;
};

/** Real, mutually exclusive speech playback, stopped when its answer is left. */
export function useResponseListening({ scope, messageId, content, onError }: ResponseListeningOptions) {
  const [speaking, setSpeaking] = useState(false);
  const playback = useRef<SpeechPlayback | null>(null);
  const mounted = useRef(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const stop = useCallback(() => {
    playback.current?.cancel();
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
    };
  }, [stop]);

  useEffect(() => () => stop(), [scope, messageId, content, stop]);

  const toggle = useCallback(() => {
    if (playback.current) {
      stop();
      return;
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      onErrorRef.current?.('이 브라우저에서는 음성 재생을 지원하지 않습니다.');
      return;
    }
    const text = responseTextForSpeech(content);
    if (!text) {
      onErrorRef.current?.('읽을 수 있는 응답이 없습니다.');
      return;
    }

    activePlayback?.cancel();
    const synthesis = window.speechSynthesis;
    const language = speechLanguage(text);
    const voices = synthesis.getVoices().filter(voice => voice.lang.toLowerCase().startsWith(language.slice(0, 2)));
    const voice = voices.find(candidate => candidate.localService) || voices[0];
    const chunks = splitSpeechText(text);
    let nextChunk = 0;
    let cancelled = false;
    let utterance: SpeechSynthesisUtterance | null = null;

    const session: SpeechPlayback = {
      cancel() {
        if (cancelled) return;
        cancelled = true;
        if (utterance) {
          utterance.onend = null;
          utterance.onerror = null;
        }
        window.removeEventListener('pagehide', session.cancel);
        if (playback.current === session) playback.current = null;
        // An old response unmounting must not stop a newer response's audio.
        if (activePlayback === session) {
          activePlayback = null;
          synthesis.cancel();
        }
        if (mounted.current) setSpeaking(false);
      },
    };

    function speakNext() {
      if (cancelled || activePlayback !== session) return;
      if (utterance) {
        utterance.onend = null;
        utterance.onerror = null;
      }
      if (nextChunk >= chunks.length) {
        session.cancel();
        return;
      }
      utterance = new SpeechSynthesisUtterance(chunks[nextChunk++]);
      utterance.lang = language;
      if (voice) utterance.voice = voice;
      utterance.onend = speakNext;
      utterance.onerror = event => {
        if (cancelled) return;
        const expectedCancellation = event.error === 'canceled' || event.error === 'interrupted';
        session.cancel();
        if (!expectedCancellation) onErrorRef.current?.('음성 재생을 시작하지 못했습니다. 브라우저의 음성 설정을 확인하고 다시 시도해 주세요.');
      };
      try {
        synthesis.speak(utterance);
      } catch {
        session.cancel();
        onErrorRef.current?.('음성 재생을 시작하지 못했습니다. 다른 브라우저에서 다시 시도해 주세요.');
      }
    }

    playback.current = session;
    activePlayback = session;
    if (mounted.current) setSpeaking(true);
    window.addEventListener('pagehide', session.cancel, { once: true });
    try {
      synthesis.cancel();
      synthesis.resume();
      speakNext();
    } catch {
      session.cancel();
      onErrorRef.current?.('음성 재생을 시작하지 못했습니다. 다른 브라우저에서 다시 시도해 주세요.');
    }
  }, [content, stop]);

  return { speaking, toggle, stop };
}
