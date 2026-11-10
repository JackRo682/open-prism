'use client';

import { useId } from 'react';

/** The folded P is shared by every Prism surface, including streamed answers. */
export function PrismMark({ size = 24, className }: { size?: number; className?: string }) {
  const id = useId();
  return <svg className={className} width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false" data-prism-mark="folded-p">
    <defs>
      <linearGradient id={`${id}-stem`} x1="4.5" y1="7" x2="11.5" y2="29.5" gradientUnits="userSpaceOnUse">
        <stop stopColor="#02C8E8"/><stop offset="1" stopColor="#1765F5"/>
      </linearGradient>
      <linearGradient id={`${id}-top`} x1="8" y1="3" x2="28" y2="15.5" gradientUnits="userSpaceOnUse">
        <stop stopColor="#15D8EF"/><stop offset=".48" stopColor="#168BFF"/><stop offset="1" stopColor="#2545EC"/>
      </linearGradient>
      <linearGradient id={`${id}-fold`} x1="11.5" y1="23.8" x2="27.5" y2="15.2" gradientUnits="userSpaceOnUse">
        <stop stopColor="#4858EF"/><stop offset="1" stopColor="#4932BD"/>
      </linearGradient>
    </defs>
    <path fill={`url(#${id}-fold)`} d="M11.5 18.8 22.7 13.7V12.5L27.5 15.1V16.9c0 1.1-.6 2.1-1.5 2.7L11.5 27.1Z"/>
    <path fill={`url(#${id}-stem)`} d="M5.9 5.8 11.5 8.6v20.1c0 .7-.5 1.2-1.2 1.2H5.7c-.7 0-1.2-.5-1.2-1.2V8.2c0-1 .5-1.9 1.4-2.4Z"/>
    <path fill={`url(#${id}-top)`} d="m5.9 5.8 4.8-2.7c.5-.3 1.1-.4 1.7-.4h6.8c.7 0 1.3.2 1.9.6l5.1 3.4c.8.5 1.3 1.4 1.3 2.4v6L11.5 8.6Z"/>
  </svg>;
}
