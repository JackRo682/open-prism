import { runnerReady } from './schedule-runner';
import type { ChatGPTUser } from '../app/chatgpt-auth';
import { AVAILABLE_CHAT_MODELS, DEFAULT_MODEL_ID, PROVIDERS, type Model, type Provider } from './models';
import { getWorkspaceCapabilities, type WorkspaceCapabilities } from './workspace-tools';

/** Only this public projection of the server configuration may reach the client. */
export type WorkspaceBootstrap = {
  user: { name: string; email: string } | null;
  beta: boolean;
  models: Model[];
  chatAccess: { freeModelId: string; freeAvailable: boolean; paidRequiresCredit: true };
  providers: Record<Provider, { configured: boolean }>;
  mediaModels: { image: string; video: string; music: string };
  capabilities: WorkspaceCapabilities & { drive: boolean; scheduled: boolean; codeExecution: boolean };
  isAdmin: boolean;
};

export function buildWorkspaceBootstrap(user: ChatGPTUser | null, environment: Cloudflare.Env): WorkspaceBootstrap {
  const beta = environment.BETA_MODE === 'true';
  return {
    user: user ? { name: user.fullName || user.email.split('@')[0], email: user.email } : null,
    beta,
    models: AVAILABLE_CHAT_MODELS,
    chatAccess: { freeModelId: DEFAULT_MODEL_ID, freeAvailable: !!environment.GEMINI_API_KEY, paidRequiresCredit: true },
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([provider, config]) => [
      provider, { configured: !!environment[config.secret as keyof Cloudflare.Env] },
    ])) as WorkspaceBootstrap['providers'],
    mediaModels: {
      image: environment.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare',
      video: environment.GEMINI_VIDEO_MODEL || 'gemini-omni-1.1-flash',
      music: environment.GEMINI_MUSIC_MODEL || 'lyria-3-clip-preview',
    },
    capabilities: {
      ...getWorkspaceCapabilities(environment),
      // Text tariffs do not include provider web-search fees.
      webResearch: false,
      drive: !!(environment.GOOGLE_DRIVE_CLIENT_ID && environment.GOOGLE_DRIVE_PICKER_KEY && environment.GOOGLE_DRIVE_APP_ID),
      remoteBrowser: !!environment.BROWSERLESS_API_TOKEN && environment.BROWSERLESS_EGRESS_POLICY_VERIFIED === 'true',
      scheduled: runnerReady(environment),
      // Paid text pricing does not include code-interpreter container charges.
      codeExecution: false,
    },
    isAdmin: !!user && !!environment.ADMIN_USER_ID && user.userId === environment.ADMIN_USER_ID,
  };
}
