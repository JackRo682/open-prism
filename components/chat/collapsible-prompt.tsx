'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import './collapsible-prompt.css';

const PREVIEW_LINES = 4;

/** Only the presentation is collapsed; callers retain the original prompt. */
export default function CollapsiblePrompt({ text, className = '' }: { text: string; className?: string }) {
  const contentId = `prism-prompt-${useId()}`;
  const contentRef = useRef<HTMLParagraphElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const expanded = expandedText === text;

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let active = true;
    function measure() {
      if (!active || !content || !content.getClientRects().length) return;
      const lineHeight = Number.parseFloat(getComputedStyle(content).lineHeight);
      if (!Number.isFinite(lineHeight)) return;
      // Measure without the toggle's reserved column. Otherwise that padding can
      // itself keep a previously overflowing prompt above four lines on resize.
      // The clamp stays in place, and the inline override is restored synchronously
      // before the browser can paint or deliver another ResizeObserver callback.
      const padding = content.style.getPropertyValue('padding-inline-end');
      const priority = content.style.getPropertyPriority('padding-inline-end');
      let naturalHeight: number;
      try {
        content.style.setProperty('padding-inline-end', '0px');
        naturalHeight = content.scrollHeight;
      } finally {
        if (padding) content.style.setProperty('padding-inline-end', padding, priority);
        else content.style.removeProperty('padding-inline-end');
      }
      // scrollHeight includes the full text while clipped and while expanded.
      setOverflows(naturalHeight > lineHeight * PREVIEW_LINES + 1);
    }
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(content);
    window.addEventListener('resize', measure);
    document.fonts?.addEventListener('loadingdone', measure);
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      document.fonts?.removeEventListener('loadingdone', measure);
    };
  }, [text]);

  return <div className={`prism-collapsible-prompt ${className}`} data-expanded={expanded} data-overflow={overflows}>
    <p id={contentId} className="prism-query-text prism-collapsible-prompt__text" ref={contentRef}>{text}</p>
    {overflows && <button
      type="button"
      className="prism-collapsible-prompt__toggle"
      aria-expanded={expanded}
      aria-controls={contentId}
      aria-label={expanded ? '접기' : '펼치기'}
      title={expanded ? '접기' : '펼치기'}
      onClick={() => setExpandedText(expanded ? null : text)}
    >
      <ChevronDown size={18} aria-hidden="true"/>
    </button>}
  </div>;
}
