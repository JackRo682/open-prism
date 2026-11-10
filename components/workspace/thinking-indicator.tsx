import './thinking-indicator.css';

export type ThinkingIndicatorProps = {
  label?: string;
  className?: string;
};

/** A quiet loading cue that never inserts a brand avatar into the answer. */
export function ThinkingIndicator({ label = '답변을 작성하고 있습니다.', className = '' }: ThinkingIndicatorProps) {
  return <span className={`prism-thinking-indicator${className ? ' ' + className : ''}`} role="status" aria-live="polite" aria-atomic="true">
    <span className="prism-thinking-dots" aria-hidden="true"><i/><i/><i/></span>
    <span className="prism-thinking-label">{label}</span>
  </span>;
}
