import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import { SCRIPT_NONCE_HEADER } from '../lib/http-security';
import './globals.css';
import './reference-shell.css';
import './workspace-details.css';
import './guest.css';
import './public.css';
import '../components/workspace/settings.css';
import '../components/workspace/composer-modes.css';
import '../components/workspace/browser-settings.css';
import '../components/workspace/creative-workspace.css';
import './markdown.css';
import './response-stream.css';
import './conversation-controls.css';
import './conversation-print.css';
import './welcome-intro.css';
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', interactiveWidget: 'resizes-content' };
export const metadata:Metadata={title:'Prism — Your AI workspace',description:'One calm workspace for GPT, Claude, and Gemini. Think deeper, compare perspectives, and make more of your ideas.',icons:{icon:[{url:'/favicon.ico?v=prism-p2',sizes:'16x16 32x32 48x48 64x64',type:'image/x-icon'},{url:'/brand/prism-mark-32.png?v=prism-p2',sizes:'32x32',type:'image/png'},{url:'/favicon.svg?v=prism-p2',sizes:'any',type:'image/svg+xml'}],shortcut:'/favicon.ico?v=prism-p2',apple:'/apple-touch-icon.png?v=prism-p2'}};
export const dynamic = 'force-dynamic';
export default async function RootLayout({children}:{children:React.ReactNode}) {
  const nonce = (await headers()).get(SCRIPT_NONCE_HEADER) || undefined;
  const preference = (await cookies()).get('prism-theme')?.value;
  const initialTheme = preference === 'light' ? 'light' : 'dark';
  // Browsers deliberately hide the nonce attribute after parsing. Suppress
  // that attribute-only hydration mismatch on this server-authored script.
  return <html lang="ko" data-theme={initialTheme} suppressHydrationWarning><head><meta name="theme-color" content={initialTheme === 'light' ? '#ffffff' : '#0f0f0f'}/><link rel="manifest" href="/manifest.webmanifest"/><script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{__html:"try{var c=document.cookie.match(/(?:^|; )prism-theme=(system|light|dark)(?:;|$)/);var t=c?c[1]:localStorage.getItem('prism-theme')||'dark';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';document.documentElement.dataset.themePreference=t;document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light'}catch{}"}}/></head><body>{children}</body></html>;
}
