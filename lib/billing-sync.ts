/** Cross-tab messages are invalidations only. Always fetch balances from the server. */
export const BILLING_UPDATED_EVENT = 'prism:billing-updated';
const CHANNEL = 'prism-billing-v1';
const STORAGE_KEY = 'prism:billing-update:v1';

export function notifyBillingUpdated(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(BILLING_UPDATED_EVENT));
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ type: BILLING_UPDATED_EVENT });
    channel.close();
  } catch { /* Storage and focus events cover browsers without BroadcastChannel. */ }
  try { localStorage.setItem(STORAGE_KEY, `${Date.now()}:${crypto.randomUUID()}`); } catch { /* Private storage may be unavailable. */ }
}

export function subscribeBillingUpdates(onInvalidate: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invalidate = () => {
    clearTimeout(timer);
    timer = setTimeout(onInvalidate, 100);
  };
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) invalidate(); };
  const onVisibility = () => { if (document.visibilityState === 'visible') invalidate(); };
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = event => { if (event.data?.type === BILLING_UPDATED_EVENT) invalidate(); };
  } catch { /* No support or storage partition access. */ }
  window.addEventListener(BILLING_UPDATED_EVENT, invalidate);
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', invalidate);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    clearTimeout(timer);
    channel?.close();
    window.removeEventListener(BILLING_UPDATED_EVENT, invalidate);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', invalidate);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
