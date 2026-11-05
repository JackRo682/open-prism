import Workspace from './workspace';
import GuestWorkspace from '../components/guest/guest-workspace';
import { chatGPTSignInPath, getChatGPTUser } from './chatgpt-auth';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const user = await getChatGPTUser();
  return user ? <Workspace /> : <GuestWorkspace signInHref={chatGPTSignInPath('/chat')} />;
}
