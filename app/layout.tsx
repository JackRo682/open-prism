import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'Prism — Your AI workspace',description:'One calm workspace for GPT, Claude, and Gemini. Think deeper, compare perspectives, and make more of your ideas.',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
