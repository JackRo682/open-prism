import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import './globals.css';
import './reference-shell.css';
import './workspace-details.css';
import '../components/workspace/settings.css';
import '../components/workspace/composer-modes.css';
import '../components/workspace/browser-settings.css';
import '../components/workspace/creative-workspace.css';
import '../components/workspace/workspace-features.css';
import '../components/workspace/integrations.css';
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', interactiveWidget: 'resizes-content' };
export const metadata:Metadata={title:'Prism — Your AI workspace',description:'One calm workspace for GPT, Claude, and Gemini. Think deeper, compare perspectives, and make more of your ideas.',icons:{icon:'/favicon.svg'}};
export default async function RootLayout({children}:{children:React.ReactNode}) {
  const preference = (await cookies()).get('prism-theme')?.value;
  const initialTheme = preference === 'light' ? 'light' : 'dark';
  return <html lang="ko" data-theme={initialTheme} suppressHydrationWarning><head><meta name="theme-color" content={initialTheme === 'light' ? '#ffffff' : '#0f0f0f'}/><link rel="manifest" href="/manifest.webmanifest"/><script dangerouslySetInnerHTML={{__html:"try{var c=document.cookie.match(/(?:^|; )prism-theme=(system|light|dark)(?:;|$)/);var t=c?c[1]:localStorage.getItem('prism-theme')||'dark';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';document.documentElement.dataset.themePreference=t;document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light'}catch{}"}}/></head><body>{children}</body></html>;
}
