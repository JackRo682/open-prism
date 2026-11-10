import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const runtime = new URL('../.sites-runtime/guest-signin-reminder-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
await writeFile(new URL('reminder.mjs', runtime), ts.transpileModule(
  await readFile(new URL('../lib/guest-signin-reminder.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText);
const {
  GUEST_SIGNIN_REMINDER_STORAGE_KEY, readGuestSignInReminder, advanceGuestSignInReminder,
  guestSignInReminderReason, markGuestSignInReminderShown, writeGuestSignInReminder,
} = await import(new URL('reminder.mjs', runtime));

function storageFixture(initial) {
  const data = new Map(initial === undefined ? [] : [[GUEST_SIGNIN_REMINDER_STORAGE_KEY, initial]]);
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
const complete = (state, promptId, isNewPrompt = true) => advanceGuestSignInReminder(state, { promptId, isNewPrompt, status: 'complete' });
const available = { available: true, remaining: 2 };

test('only three distinct successful new prompts make the encouragement eligible', () => {
  let state = readGuestSignInReminder([], null);
  assert.equal(guestSignInReminderReason(state, available), null);
  for (const promptId of ['first', 'second']) {
    state = complete(state, promptId);
    assert.equal(guestSignInReminderReason(state, available), null);
  }
  state = complete(state, 'third');
  assert.equal(guestSignInReminderReason(state, available), 'encouragement');
  assert.deepEqual(state.completedPromptIds, ['first', 'second', 'third']);
  assert.equal(complete(state, 'fourth'), state, 'the cadence is capped and never becomes a usage ledger');
});

test('duplicate completion, failed/stopped streams, retries, edits, and regenerations do not count', () => {
  const state = complete(readGuestSignInReminder([], null), 'first');
  assert.equal(complete(state, 'first'), state);
  for (const status of ['streaming', 'stopped', 'error']) {
    assert.equal(advanceGuestSignInReminder(state, { promptId: 'next', isNewPrompt: true, status }), state);
  }
  for (const promptId of ['retry-with-same-id', 'edit-with-new-id', 'regeneration-with-new-id']) assert.equal(complete(state, promptId, false), state);
  for (const promptId of ['', 'bad id', 'x'.repeat(81)]) assert.equal(complete(state, promptId), state);
  assert.equal(state.completedTurns, 1);
});

test('history seeds the first restore, while refresh retains the authoritative persisted cadence', () => {
  const storage = storageFixture();
  let state = readGuestSignInReminder(['first', 'second'], storage);
  assert.equal(state.completedTurns, 2);
  assert.equal(writeGuestSignInReminder(state, storage), true);
  state = readGuestSignInReminder(['first', 'second', 'second'], storage);
  assert.equal(state.completedTurns, 2);
  state = complete(state, 'third');
  assert.equal(guestSignInReminderReason(state, available), 'encouragement');
  state = markGuestSignInReminderShown(state, 'encouragement');
  writeGuestSignInReminder(state, storage);
  assert.equal(guestSignInReminderReason(readGuestSignInReminder(['first', 'second', 'third'], storage), available), null);
  assert.equal(guestSignInReminderReason(readGuestSignInReminder([], storage), available), null, 'starting a new conversation does not reset a shown invitation');
});

test('distinct completed prompts across conversations retain progress in the same tab', () => {
  const storage = storageFixture();
  writeGuestSignInReminder(readGuestSignInReminder(['previous-chat'], null), storage);
  let restored = readGuestSignInReminder([], storage);
  assert.equal(restored.completedTurns, 1, 'new chat keeps the earlier successful turn');
  restored = complete(restored, 'current-chat-1');
  restored = complete(restored, 'current-chat-2');
  writeGuestSignInReminder(restored, storage);
  restored = readGuestSignInReminder(['current-chat-1', 'current-chat-2'], storage);
  assert.equal(restored.completedTurns, 3);
  assert.equal(guestSignInReminderReason(restored, available), 'encouragement');
});

test('editing to a new prompt ID and refreshing never turns the edit into another successful new turn', () => {
  const storage = storageFixture();
  let state = complete(complete(readGuestSignInReminder([], storage), 'first'), 'second');
  writeGuestSignInReminder(state, storage);
  for (const editedId of ['second-edit-1', 'second-edit-2', 'second-edit-3']) {
    state = complete(state, editedId, false);
    writeGuestSignInReminder(state, storage);
    state = readGuestSignInReminder(['first', editedId], storage);
    assert.equal(state.completedTurns, 2);
    assert.deepEqual(state.completedPromptIds, ['first', 'second']);
    assert.equal(guestSignInReminderReason(state, available), null);
  }
  state = complete(state, 'third-new-prompt');
  assert.equal(guestSignInReminderReason(state, available), 'encouragement');
});

test('a valid persisted zero count is authoritative even if the visible history has different IDs', () => {
  const storage = storageFixture();
  writeGuestSignInReminder(readGuestSignInReminder([], null), storage);
  const state = readGuestSignInReminder(['replacement-a', 'replacement-b', 'replacement-c'], storage);
  assert.equal(state.completedTurns, 0);
  assert.deepEqual(state.completedPromptIds, []);
  assert.equal(guestSignInReminderReason(state, available), null);
});

test('one later quota dialog is permitted, with no immediate encouragement queued behind it', () => {
  let state = markGuestSignInReminderShown(readGuestSignInReminder(['a', 'b', 'c'], null), 'encouragement');
  assert.equal(guestSignInReminderReason(state, available), null);
  assert.equal(guestSignInReminderReason(state, { available: true, remaining: 0 }), 'limit');
  state = markGuestSignInReminderShown(state, 'limit');
  assert.equal(guestSignInReminderReason(state, { available: true, remaining: 0 }), null);
  assert.equal(guestSignInReminderReason(state, { available: true, remaining: -1 }), null);
  assert.equal(guestSignInReminderReason(state, available), null);

  const limitFirst = markGuestSignInReminderShown(readGuestSignInReminder(['a', 'b', 'c'], null), 'limit');
  assert.equal(guestSignInReminderReason(limitFirst, available), null);
  const storage = storageFixture();
  writeGuestSignInReminder(limitFirst, storage);
  assert.equal(guestSignInReminderReason(readGuestSignInReminder([], storage), { available: true, remaining: 0 }), null);
});

test('service failures and unknown usage never produce an exhaustion or encouragement dialog', () => {
  const state = readGuestSignInReminder(['a', 'b', 'c'], null);
  for (const usage of [null, undefined, { available: false, remaining: 0 }, { available: false, remaining: 2 }, { available: true, remaining: NaN }, { available: true, remaining: Infinity }]) {
    assert.equal(guestSignInReminderReason(state, usage), null);
  }
  assert.equal(guestSignInReminderReason(state, { available: true, remaining: 0 }), 'limit');
});

test('disabled or full browser storage does not prevent an in-memory cadence or dismissal', () => {
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  let state = readGuestSignInReminder(['first', 'second'], blocked);
  state = complete(state, 'third');
  assert.equal(writeGuestSignInReminder(state, blocked), false);
  assert.equal(guestSignInReminderReason(state, available), 'encouragement');
  state = markGuestSignInReminderShown(state, 'encouragement');
  assert.equal(writeGuestSignInReminder(state, null), false);
  assert.equal(guestSignInReminderReason(state, available), null);
  assert.doesNotThrow(() => readGuestSignInReminder());
});

test('malformed, oversized, or untrusted persisted state falls back to validated conversation progress', () => {
  const valid = { version: 1, completedTurns: 1, completedPromptIds: ['first'], encouragementShown: false, limitShown: false };
  const malformed = ['not-json', 'x'.repeat(2049), null, [], { ...valid, version: 2 }, { ...valid, completedTurns: -1 },
    { ...valid, completedTurns: 2.5 }, { ...valid, completedTurns: 4 }, { ...valid, completedPromptIds: ['bad id'] },
    { ...valid, completedPromptIds: ['first', 'first'] }, { ...valid, completedPromptIds: ['a', 'b'] },
    { ...valid, encouragementShown: 'yes' }, { ...valid, limitShown: 0 }];
  for (const value of malformed) {
    const restored = readGuestSignInReminder(['baseline'], storageFixture(typeof value === 'string' ? value : JSON.stringify(value)));
    assert.deepEqual(restored, { completedTurns: 1, completedPromptIds: ['baseline'], encouragementShown: false, limitShown: false });
  }
  const storage = storageFixture();
  assert.equal(writeGuestSignInReminder({ ...readGuestSignInReminder([], null), completedTurns: 10 }, storage), false);
  assert.equal(storage.data.size, 0);
});
