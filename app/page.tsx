import { env } from 'cloudflare:workers';
import Workspace from './workspace';
import GuestWorkspace from '../components/guest/guest-workspace';
import { chatGPTSignInPath, getChatGPTUser } from './chatgpt-auth';
import { loadWorkspaceStartup } from '../lib/workspace-startup';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const user = await getChatGPTUser();
  if (!user) return <GuestWorkspace signInHref={chatGPTSignInPath('/chat')} />;
  const startup = await loadWorkspaceStartup(user, env);
  return <Workspace key={user.userId} initialPathname="/" initialBootstrap={startup.bootstrap} initialChats={startup.chats} />;
}
