import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '../../components/upgrade/upgrade.css';

export const metadata: Metadata = {
  title: '업그레이드 · Prism',
  description: 'Prism AI 크레딧의 충전 금액과 구매 조건을 확인하세요.',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { themeColor: '#ffffff' };

export default function UpgradeLayout({ children }: { children: ReactNode }) { return children; }
