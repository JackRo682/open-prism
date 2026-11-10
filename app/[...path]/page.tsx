import { env } from 'cloudflare:workers';
import { redirect } from 'next/navigation';
import Workspace from '../workspace';
import GuestWorkspace from '../../components/guest/guest-workspace';
import PublicPage, { PublicSharePage } from '../public-page';
import { chatGPTSignInPath, getChatGPTUser, requireChatGPTUser } from '../chatgpt-auth';
import { loadWorkspaceStartup } from '../../lib/workspace-startup';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const pathname = '/' + path.map(encodeURIComponent).join('/');
  const user = await getChatGPTUser();

  // Public links keep working without exposing the authenticated workspace shell.
  if (!user && path[0] === 'share' && path.length === 2) return <PublicSharePage token={path[1]} signedIn={false} />;
  if (!user && ['about', 'privacy', 'terms', 'faq', 'help', 'docs'].includes(path[0]) && path.length === 1) {
    return <PublicPage page={path[0] === 'about' ? 'about' : path[0] === 'privacy' ? 'privacy' : path[0] === 'terms' ? 'terms' : 'faq'} />;
  }
  if (!user && path.length === 1 && path[0] === 'chat') {
    return <GuestWorkspace signInHref={chatGPTSignInPath('/chat')} />;
  }
  if (['login', 'signup', 'auth', 'forgot-password'].includes(path[0]) && path.length === 1) {
    redirect(user ? '/chat' : chatGPTSignInPath('/chat'));
  }
  const authenticatedUser = user ?? await requireChatGPTUser(pathname);
  const startup = await loadWorkspaceStartup(authenticatedUser, env);
  return <Workspace key={authenticatedUser.userId} initialPathname={pathname} initialBootstrap={startup.bootstrap} initialChats={startup.chats} />;
}
