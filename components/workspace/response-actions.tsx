'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { DropdownMenu, Tooltip } from 'radix-ui';
import { Check, Copy, Expand, FileText, Flag, Mail, MoreHorizontal, RotateCw, Shrink, SlidersVertical, Square, ThumbsDown, ThumbsUp, UserRoundX, Volume2, X } from 'lucide-react';
import { useResponseListening } from '../../hooks/use-response-actions';
import './response-actions.css';

type ResponseAction = () => void | Promise<unknown>;
export type ResponseFeedback = 'up' | 'down' | null;
export type RegenerateStyle = 'longer' | 'shorter' | 'no_personalization' | 'retry';
const FEEDBACK_REASONS = ['불쾌감을 주거나 안전하지 않음', '사실과 다름', '요청 사항을 따르지 않음', '개인화 문제', '기타'];
const MAX_FEEDBACK_DETAILS = 2000;

export type ResponseActionsProps = {
  messageId: string;
  content: string;
  /** Current route/chat identity. Moving away stops this answer's audio. */
  scope: string;
  copied?: boolean;
  feedback?: ResponseFeedback;
  feedbackDestination?: 'prism' | 'browser';
  isLatest?: boolean;
  disabled?: boolean;
  regenerateDisabled?: boolean;
  onCopy: ResponseAction;
  onFeedback(value: ResponseFeedback, details?: string): void | Promise<unknown>;
  onRegenerate?(style?: RegenerateStyle): void | Promise<unknown>;
  onExportDocs: ResponseAction;
  onCreateGmailDraft: ResponseAction;
  onReportLegalIssue: ResponseAction;
  onViewDetails: ResponseAction;
  onError?(message: string): void;
  className?: string;
};

function ActionTooltip({ label, children }: { label: string; children: ReactNode }) {
  return <Tooltip.Root>
    <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content className="prism-response-tooltip" side="bottom" sideOffset={6} collisionPadding={8}>{label}</Tooltip.Content></Tooltip.Portal>
  </Tooltip.Root>;
}

/** Identical response controls for signed-in and guest conversations. */
export function ResponseActions({
  messageId,
  content,
  scope,
  copied = false,
  feedback = null,
  feedbackDestination = 'prism',
  isLatest = false,
  disabled = false,
  regenerateDisabled = false,
  onCopy,
  onFeedback,
  onRegenerate,
  onExportDocs,
  onCreateGmailDraft,
  onReportLegalIssue,
  onViewDetails,
  onError,
  className = '',
}: ResponseActionsProps) {
  const [pendingFeedback, setPendingFeedback] = useState(false);
  const [feedbackFormOpen, setFeedbackFormOpen] = useState(false);
  const [feedbackReason, setFeedbackReason] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackNotice, setFeedbackNotice] = useState('');
  const [error, setError] = useState('');
  const feedbackFormId = useId();
  const mounted = useRef(false);
  const feedbackRequest = useRef(false);
  const feedbackEpoch = useRef(0);
  const downRef = useRef<HTMLButtonElement>(null);
  const feedbackHeadingRef = useRef<HTMLHeadingElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const handingOffFocus = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    feedbackEpoch.current++;
    feedbackRequest.current = false;
    setPendingFeedback(false);
    setFeedbackFormOpen(false);
    setFeedbackReason(null);
    setFeedbackText('');
    setFeedbackNotice('');
    setError('');
    return () => { feedbackEpoch.current++; };
  }, [scope, messageId]);
  useEffect(() => {
    if (feedbackFormOpen) feedbackHeadingRef.current?.focus();
  }, [feedbackFormOpen, feedback]);

  const reportError = useCallback((message: string) => {
    if (!mounted.current) return;
    if (onError) onError(message);
    else setError(message);
  }, [onError]);
  const listening = useResponseListening({ scope, messageId, content, onError: reportError });

  async function run(action: ResponseAction) {
    if (mounted.current) setError('');
    try { await action(); }
    catch (failure) { reportError(failure instanceof Error ? failure.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.'); }
  }

  async function rate(value: Exclude<ResponseFeedback, null>) {
    if (disabled || feedbackRequest.current) return;
    feedbackRequest.current = true;
    const epoch = feedbackEpoch.current;
    const next = feedback === value ? null : value;
    setPendingFeedback(true);
    setError('');
    try {
      await onFeedback(next);
      if (mounted.current && feedbackEpoch.current === epoch) {
        setFeedbackFormOpen(next === 'down');
        setFeedbackReason(null);
        setFeedbackText('');
        setFeedbackNotice('');
      }
    } catch (failure) {
      if (feedbackEpoch.current === epoch) reportError(failure instanceof Error ? failure.message : '의견을 저장하지 못했습니다. 다시 시도해 주세요.');
    }
    finally {
      if (mounted.current && feedbackEpoch.current === epoch) {
        feedbackRequest.current = false;
        setPendingFeedback(false);
      }
    }
  }

  const feedbackDetails = [feedbackReason, feedbackText.trim()].filter(Boolean).join('\n\n');
  function closeFeedback() {
    setFeedbackFormOpen(false);
    const epoch = feedbackEpoch.current;
    window.requestAnimationFrame(() => { if (mounted.current && feedbackEpoch.current === epoch) downRef.current?.focus(); });
  }
  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || feedbackRequest.current || feedback !== 'down' || !feedbackDetails || feedbackDetails.length > MAX_FEEDBACK_DETAILS) return;
    feedbackRequest.current = true;
    const epoch = feedbackEpoch.current;
    setPendingFeedback(true);
    setError('');
    try {
      await onFeedback('down', feedbackDetails);
      if (mounted.current && feedbackEpoch.current === epoch) {
        closeFeedback();
        setFeedbackNotice(feedbackDestination === 'browser' ? '이 브라우저에 추가 의견을 저장했습니다.' : '추가 의견을 보냈습니다.');
      }
    } catch (failure) {
      if (feedbackEpoch.current === epoch) reportError(failure instanceof Error ? failure.message : '의견을 저장하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      if (mounted.current && feedbackEpoch.current === epoch) {
        feedbackRequest.current = false;
        setPendingFeedback(false);
      }
    }
  }

  function openAction(action: ResponseAction) {
    // The dialog/drawer opened by the owner should receive focus after the menu
    // closes, without the dropdown restoring focus over it.
    handingOffFocus.current = true;
    triggerRef.current?.focus();
    void run(action);
  }

  const copyLabel = copied ? '응답 복사됨' : '응답 복사';
  return <div className={`prism-response-actions${className ? ' ' + className : ''}`} data-response-id={messageId}>
    <Tooltip.Provider delayDuration={450} skipDelayDuration={150}>
      <div className="prism-response-toolbar" role="group" aria-label="응답 작업">
        <ActionTooltip label="좋은 응답"><button type="button" className="prism-response-action" aria-label="좋은 응답" aria-pressed={feedback === 'up'} disabled={disabled || pendingFeedback} onClick={() => void rate('up')}><ThumbsUp size={18} fill={feedback === 'up' ? 'currentColor' : 'none'} aria-hidden="true"/></button></ActionTooltip>
        <ActionTooltip label="별로인 응답"><button ref={downRef} type="button" className="prism-response-action" aria-label="별로인 응답" aria-pressed={feedback === 'down'} aria-expanded={feedbackFormOpen && feedback === 'down'} aria-controls={feedbackFormOpen && feedback === 'down' ? feedbackFormId : undefined} disabled={disabled || pendingFeedback} onClick={() => void rate('down')}><ThumbsDown size={18} fill={feedback === 'down' ? 'currentColor' : 'none'} aria-hidden="true"/></button></ActionTooltip>
        {isLatest && onRegenerate && <DropdownMenu.Root modal={false}>
          <ActionTooltip label="다시 생성"><DropdownMenu.Trigger asChild><button type="button" className="prism-response-action" aria-label="답변 다시 생성" disabled={disabled || regenerateDisabled}><RotateCw size={18} aria-hidden="true"/></button></DropdownMenu.Trigger></ActionTooltip>
          <DropdownMenu.Portal><DropdownMenu.Content className="prism-response-menu prism-response-regenerate-menu" aria-label="답변 다시 생성 방식" side="top" align="start" sideOffset={8} collisionPadding={12} loop>
            <DropdownMenu.Item className="prism-response-menu-item" onSelect={() => { listening.stop(); void run(() => onRegenerate('longer')); }}><Expand size={18} aria-hidden="true"/><span>길게</span></DropdownMenu.Item>
            <DropdownMenu.Item className="prism-response-menu-item" onSelect={() => { listening.stop(); void run(() => onRegenerate('shorter')); }}><Shrink size={18} aria-hidden="true"/><span>짧게</span></DropdownMenu.Item>
            <DropdownMenu.Item className="prism-response-menu-item" onSelect={() => { listening.stop(); void run(() => onRegenerate('no_personalization')); }}><UserRoundX size={18} aria-hidden="true"/><span>맞춤설정하지 않음</span></DropdownMenu.Item>
            <DropdownMenu.Item className="prism-response-menu-item" onSelect={() => { listening.stop(); void run(() => onRegenerate('retry')); }}><RotateCw size={18} aria-hidden="true"/><span>다시 시도</span></DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>}
        <ActionTooltip label={copied ? '복사됨' : '응답 복사'}><button type="button" className="prism-response-action" data-copied={copied} aria-label={copyLabel} disabled={disabled || !content} onClick={() => void run(onCopy)}>{copied ? <Check size={18} aria-hidden="true"/> : <Copy size={18} aria-hidden="true"/>}</button></ActionTooltip>
        <DropdownMenu.Root modal={false}>
          <ActionTooltip label="더보기"><DropdownMenu.Trigger asChild><button ref={triggerRef} type="button" className="prism-response-action" aria-label="응답 더보기" disabled={disabled}><MoreHorizontal size={18} aria-hidden="true"/></button></DropdownMenu.Trigger></ActionTooltip>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="prism-response-menu" aria-label="응답 메뉴" side="top" align="start" sideOffset={8} collisionPadding={12} loop onCloseAutoFocus={event => {
              if (handingOffFocus.current) {
                event.preventDefault();
                handingOffFocus.current = false;
              }
            }}>
              <DropdownMenu.Item className="prism-response-menu-item" data-active={listening.speaking || undefined} onSelect={listening.toggle} disabled={!content}>{listening.speaking ? <Square size={18} aria-hidden="true"/> : <Volume2 size={18} aria-hidden="true"/>}<span>{listening.speaking ? '듣기 중지' : '듣기'}</span></DropdownMenu.Item>
              <DropdownMenu.Item className="prism-response-menu-item" onSelect={() => openAction(onExportDocs)}><FileText size={18} aria-hidden="true"/><span>Docs로 내보내기</span></DropdownMenu.Item>
              <DropdownMenu.Item className="prism-response-menu-item" onSelect={() => openAction(onCreateGmailDraft)}><Mail size={18} aria-hidden="true"/><span>Gmail 초안 작성</span></DropdownMenu.Item>
              <DropdownMenu.Item className="prism-response-menu-item" onSelect={() => openAction(onReportLegalIssue)}><Flag size={18} aria-hidden="true"/><span>법적 문제 신고</span></DropdownMenu.Item>
              <DropdownMenu.Item className="prism-response-menu-item" onSelect={() => openAction(onViewDetails)}><SlidersVertical size={18} aria-hidden="true"/><span>응답 세부정보 보기</span></DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </Tooltip.Provider>
    {feedbackFormOpen && feedback === 'down' && <form id={feedbackFormId} className="prism-response-feedback" aria-labelledby={`${feedbackFormId}-title`} aria-busy={pendingFeedback} onSubmit={event => void submitFeedback(event)} onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing && !pendingFeedback) { event.stopPropagation(); closeFeedback(); }
    }}>
      <div className="prism-response-feedback-heading"><h3 id={`${feedbackFormId}-title`} ref={feedbackHeadingRef} tabIndex={-1}>무엇이 문제였나요?</h3><button type="button" className="prism-response-action" aria-label="의견 양식 닫기" disabled={pendingFeedback} onClick={closeFeedback}><X size={18} aria-hidden="true"/></button></div>
      <fieldset disabled={disabled || pendingFeedback}>
        <legend className="prism-response-sr-only">이 응답에 대한 추가 의견</legend>
        <div className="prism-response-feedback-reasons" role="group" aria-label="문제 유형">
          {FEEDBACK_REASONS.map(reason => <button key={reason} type="button" className="prism-response-feedback-chip" aria-pressed={feedbackReason === reason} onClick={() => setFeedbackReason(previous => previous === reason ? null : reason)}>{reason}</button>)}
        </div>
        <label className="prism-response-sr-only" htmlFor={`${feedbackFormId}-details`}>추가 의견 제공</label>
        <textarea id={`${feedbackFormId}-details`} value={feedbackText} onChange={event => setFeedbackText(event.target.value)} placeholder="추가 의견 제공" rows={3} maxLength={MAX_FEEDBACK_DETAILS} aria-describedby={`${feedbackFormId}-notice ${feedbackFormId}-count`} aria-invalid={feedbackDetails.length > MAX_FEEDBACK_DETAILS}/>
        <p id={`${feedbackFormId}-notice`} className="prism-response-feedback-notice">{feedbackDestination === 'browser' ? '이 응답에 대한 의견을 이 브라우저에 저장합니다.' : '이 응답에 대한 의견을 Prism에 보냅니다.'}</p>
        <div className="prism-response-feedback-footer"><span id={`${feedbackFormId}-count`} className="prism-response-feedback-count" data-invalid={feedbackDetails.length > MAX_FEEDBACK_DETAILS || undefined}>{feedbackDetails.length.toLocaleString()} / 2,000</span><button type="submit" className="prism-response-feedback-submit" disabled={!feedbackDetails || feedbackDetails.length > MAX_FEEDBACK_DETAILS}>{pendingFeedback ? '제출 중…' : '제출'}</button></div>
      </fieldset>
    </form>}
    <span className="prism-response-sr-only" role="status" aria-live="polite">{listening.speaking ? '응답을 읽고 있습니다.' : ''}</span>
    <span className="prism-response-sr-only" role="status" aria-live="polite">{feedbackNotice}</span>
    {error && <p className="prism-response-error" role="alert">{error}</p>}
  </div>;
}
