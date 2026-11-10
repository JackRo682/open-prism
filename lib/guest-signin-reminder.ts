export const GUEST_SIGNIN_REMINDER_STORAGE_KEY = 'prism-guest-signin-reminder:v1';
export const GUEST_SIGNIN_REMINDER_AFTER_TURNS = 3;

export type GuestSignInReminderReason = 'encouragement' | 'limit';
export type GuestSignInReminderState = {
  /** Saturates at the reminder threshold; this is not a usage counter. */
  completedTurns: number;
  completedPromptIds: string[];
  encouragementShown: boolean;
  limitShown: boolean;
};
export type GuestSignInReminderStorage = Pick<Storage, 'getItem' | 'setItem'>;

type CompletedTurn = {
  promptId: string;
  status: 'complete' | 'streaming' | 'stopped' | 'error';
  /** False for edits, retries, and regenerations, even if their IDs change. */
  isNewPrompt: boolean;
};
type GuestAvailability = { available: boolean; remaining: number };

const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const emptyState = (): GuestSignInReminderState => ({ completedTurns: 0, completedPromptIds: [], encouragementShown: false, limitShown: false });

function browserStorage(): GuestSignInReminderStorage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; }
  catch { return null; }
}

function parseState(value: unknown): GuestSignInReminderState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || !Number.isInteger(state.completedTurns) || (state.completedTurns as number) < 0 || (state.completedTurns as number) > GUEST_SIGNIN_REMINDER_AFTER_TURNS ||
    !Array.isArray(state.completedPromptIds) || state.completedPromptIds.length > GUEST_SIGNIN_REMINDER_AFTER_TURNS || !state.completedPromptIds.every(validId) ||
    new Set(state.completedPromptIds).size !== state.completedPromptIds.length || (state.completedTurns as number) < state.completedPromptIds.length ||
    typeof state.encouragementShown !== 'boolean' || typeof state.limitShown !== 'boolean') return null;
  return {
    completedTurns: state.completedTurns as number,
    completedPromptIds: [...state.completedPromptIds],
    encouragementShown: state.encouragementShown || state.limitShown,
    limitShown: state.limitShown,
  };
}

/** Restore once at mount. Seed from history only when no valid cadence state exists. */
export function readGuestSignInReminder(initialCompletedPromptIds: readonly string[] = [], storage: GuestSignInReminderStorage | null = browserStorage()): GuestSignInReminderState {
  try {
    const raw = storage?.getItem(GUEST_SIGNIN_REMINDER_STORAGE_KEY);
    if (raw && raw.length <= 2048) {
      const restored = parseState(JSON.parse(raw));
      // Editing a prompt replaces its ID. History therefore cannot distinguish
      // an edit from a new turn; the persisted completion ledger is authoritative.
      if (restored) return restored;
    }
  } catch { /* Keep the caller's in-memory state usable when storage is unavailable. */ }
  const ids = [...new Set(initialCompletedPromptIds.filter(validId))].slice(0, GUEST_SIGNIN_REMINDER_AFTER_TURNS);
  return { ...emptyState(), completedTurns: ids.length, completedPromptIds: ids };
}

/** Call on a completed response; failed/aborted or non-new turns cannot advance the cadence. */
export function advanceGuestSignInReminder(state: GuestSignInReminderState, turn: CompletedTurn): GuestSignInReminderState {
  if (turn.status !== 'complete' || !turn.isNewPrompt || !validId(turn.promptId) || state.completedTurns >= GUEST_SIGNIN_REMINDER_AFTER_TURNS || state.completedPromptIds.includes(turn.promptId)) return state;
  return { ...state, completedTurns: state.completedTurns + 1, completedPromptIds: [...state.completedPromptIds, turn.promptId] };
}

/** Availability must be confirmed, so service/network failures never masquerade as quota exhaustion. */
export function guestSignInReminderReason(state: GuestSignInReminderState, usage: GuestAvailability | null | undefined): GuestSignInReminderReason | null {
  if (!usage?.available || !Number.isFinite(usage.remaining)) return null;
  if (usage.remaining <= 0) return state.limitShown ? null : 'limit';
  return state.completedTurns >= GUEST_SIGNIN_REMINDER_AFTER_TURNS && !state.encouragementShown && !state.limitShown ? 'encouragement' : null;
}

export function markGuestSignInReminderShown(state: GuestSignInReminderState, reason: GuestSignInReminderReason): GuestSignInReminderState {
  // Seeing the quota dialog also satisfies the softer invitation; do not queue it behind the dialog.
  return { ...state, encouragementShown: true, limitShown: state.limitShown || reason === 'limit' };
}

/** Persist best-effort. Keep using the returned reducer state even when this reports false. */
export function writeGuestSignInReminder(state: GuestSignInReminderState, storage: GuestSignInReminderStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    const checked = parseState({ ...state, version: 1 });
    if (!checked) return false;
    storage.setItem(GUEST_SIGNIN_REMINDER_STORAGE_KEY, JSON.stringify({ version: 1, ...checked }));
    return true;
  } catch { return false; }
}
