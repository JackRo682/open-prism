export type GuestMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'complete' | 'streaming' | 'stopped' | 'error';
  error?: string;
};

export type GuestSession = {
  id: string;
  messages: GuestMessage[];
  draft: string;
  savedAt: number;
  hasInteracted: boolean;
};

export const GUEST_SESSION_STORAGE_KEY = 'prism-guest-session';
const MAX_AGE = 60 * 60 * 1000;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function clearGuestSession(): void {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.removeItem(GUEST_SESSION_STORAGE_KEY); } catch { /* Storage can be disabled. */ }
}

export function readGuestSession(): GuestSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(GUEST_SESSION_STORAGE_KEY);
    if (!raw || raw.length > 160000) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const data = value as Record<string, unknown>;
    if (typeof data.id !== 'string' || !ID.test(data.id) || typeof data.savedAt !== 'number' || Date.now() - data.savedAt > MAX_AGE || data.savedAt > Date.now() + 60000 || !Array.isArray(data.messages) || data.messages.length > 40 || typeof data.draft !== 'string' || data.draft.length > 8000) {
      clearGuestSession();
      return null;
    }
    const messages: GuestMessage[] = [];
    let total = 0;
    for (const candidate of data.messages) {
      if (!candidate || typeof candidate !== 'object') return null;
      const item = candidate as Record<string, unknown>;
      const expectedRole = messages.length % 2 === 0 ? 'user' : 'assistant';
      if (item.role !== expectedRole || typeof item.id !== 'string' || item.id.length > 80 || typeof item.content !== 'string' || item.content.length > 32000) return null;
      total += item.content.length;
      if (total > 100000) return null;
      const status = item.status === 'streaming' ? 'stopped' : item.status === 'stopped' || item.status === 'error' ? item.status : 'complete';
      messages.push({ id: item.id, role: expectedRole, content: item.content, status, ...(typeof item.error === 'string' ? { error: item.error.slice(0, 500) } : {}) });
    }
    return { id: data.id, messages, draft: data.draft, savedAt: data.savedAt, hasInteracted: data.hasInteracted === true || messages.some(message => message.role === 'assistant' && message.status === 'complete') };
  } catch { return null; }
}

export function writeGuestSession(session: GuestSession): void {
  if (typeof window === 'undefined') return;
  try {
    const messages = session.messages.slice(-40).map(message => ({ ...message, content: message.content.slice(0, 32000) }));
    if (messages[0]?.role === 'assistant') messages.shift();
    while (messages.length > 2 && messages.reduce((total, message) => total + message.content.length, 0) > 100000) messages.splice(0, 2);
    window.sessionStorage.setItem(GUEST_SESSION_STORAGE_KEY, JSON.stringify({ ...session, version: 1, messages, draft: session.draft.slice(0, 8000), savedAt: Date.now() }));
  } catch { /* An unavailable browser store must not prevent chatting. */ }
}
