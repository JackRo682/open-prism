import type { Metadata } from 'next';
import './globals.css';
import './reference-shell.css';
import './workspace-details.css';
import '../components/workspace/settings.css';
export const metadata:Metadata={title:'Prism — Your AI workspace',description:'One calm workspace for GPT, Claude, and Gemini. Think deeper, compare perspectives, and make more of your ideas.',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ko" data-theme="dark" suppressHydrationWarning><head><meta name="theme-color" content="#0f0f0f"/><link rel="manifest" href="/manifest.webmanifest"/><script dangerouslySetInnerHTML={{__html:"try{var t=localStorage.getItem('prism-theme')||'dark';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light'}catch{}"}}/></head><body>{children}</body></html>}
