import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const directory = new URL('../.sites-runtime/workspace-navigation-tests/', import.meta.url);
await mkdir(directory, { recursive: true });
const source = await readFile(new URL('../lib/workspace-navigation.ts', import.meta.url), 'utf8');
await writeFile(new URL('navigation.mjs', directory), ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const {
  initializeWorkspaceHistory, navigateWorkspaceHistory, resolveWorkspaceNavigation,
  restoreWorkspaceHistory, isNewChatShortcut,
} = await import(new URL('navigation.mjs', directory));

function fixture(initial = '/chat/a') {
  let url = new URL(initial, 'https://getopenprism.com');
  let index = 0;
  const initialMetadata = { frameworkTree: { slot: 'workspace' }, scroll: 123 };
  const entries = [{ href: url.href, state: initialMetadata }];
  const changes = [];
  const writes = [];
  const host = {
    get location() { return url; },
    history: {
      get state() { return entries[index].state; },
      pushState(state, _unused, href) {
        url = new URL(href, url); entries.splice(++index); entries.push({ href: url.href, state });
        writes.push('push');
      },
      replaceState(state, _unused, href) {
        url = new URL(href, url); entries[index] = { href: url.href, state };
        writes.push('replace');
      },
    },
  };
  const onPathname = path => changes.push(path);
  function traverse(delta) {
    index += delta; assert.ok(index >= 0 && index < entries.length);
    url = new URL(entries[index].href);
    let stopped = false;
    const event = { state: entries[index].state, stopImmediatePropagation() { stopped = true; } };
    const restored = restoreWorkspaceHistory(host, event, onPathname);
    return { restored, stopped };
  }
  return { host, entries, changes, writes, initialMetadata, onPathname, traverse };
}

test('conversation and implemented settings destinations use client navigation and retain query/hash', () => {
  const origin = 'https://getopenprism.com';
  for (const path of [
    '/', '/chat', '/chat/conversation-1', '/history', '/library',
    '/settings', '/personalization-settings', '/gemini-spark', '/browser-settings',
    '/customize', '/customize/skills', '/gems/view', '/import', '/sharing', '/feedback',
    '/usage', '/billing', '/pricing', '/models', '/models/openai', '/models/anthropic', '/models/google',
    '/faq', '/docs', '/privacy', '/terms',
  ]) {
    assert.deepEqual(resolveWorkspaceNavigation(path, origin), { kind: 'workspace', href: path, pathname: path });
  }
  assert.deepEqual(resolveWorkspaceNavigation(origin + '/chat/conversation-1?source=search#latest', origin), {
    kind: 'workspace', href: '/chat/conversation-1?source=search#latest', pathname: '/chat/conversation-1',
  });
  for (const path of ['/signin-with-chatgpt?return_to=%2Fchat', '/signout-with-chatgpt', '/callback', '/login', '/signup', '/auth', '/api/conversations', '/unknown', '/chat/a/other', '/models/unknown', '/share/invalid', '/settings/unknown', '/settings/api', '/customize/unknown', '/notebooks/new', '/share/' + 'a'.repeat(64), '/browser?url=https%3A%2F%2Fexample.com#preview', '/images', '/scheduled']) {
    assert.deepEqual(resolveWorkspaceNavigation(path, origin), { kind: 'router', href: path });
  }
  assert.deepEqual(resolveWorkspaceNavigation('https://example.com/chat', origin), { kind: 'router', href: 'https://example.com/chat' });
  assert.deepEqual(resolveWorkspaceNavigation('//example.com/chat', origin), { kind: 'router', href: 'https://example.com/chat' });
});

test('opening account settings and preference pages keeps one history shell through Back and Forward', () => {
  const f = fixture('/chat/saved-conversation');
  initializeWorkspaceHistory(f.host);
  for (const path of ['/settings', '/personalization-settings', '/customize/skills', '/settings']) {
    assert.equal(navigateWorkspaceHistory(f.host, path, f.onPathname), true);
  }
  assert.equal(f.entries.length, 5);
  for (const path of ['/customize/skills', '/personalization-settings', '/settings', '/chat/saved-conversation']) {
    assert.deepEqual(f.traverse(-1), { restored: true, stopped: true });
    assert.equal(f.host.location.pathname, path);
  }
  assert.deepEqual(f.traverse(1), { restored: true, stopped: true });
  assert.equal(f.host.location.pathname, '/settings');
  assert.ok(f.entries.every(entry => entry.state.frameworkTree.slot === 'workspace'));
});

test('a direct settings load can visit a chat and return without replacing the initial settings entry', () => {
  const f = fixture('/settings?section=account#profile');
  assert.equal(navigateWorkspaceHistory(f.host, '/chat/saved-conversation', f.onPathname), true);
  assert.equal(f.entries.length, 2);
  assert.deepEqual(f.traverse(-1), { restored: true, stopped: true });
  assert.equal(f.host.location.pathname, '/settings');
  assert.equal(f.host.location.search, '?section=account');
  assert.equal(f.host.location.hash, '#profile');
  assert.deepEqual(f.traverse(1), { restored: true, stopped: true });
  assert.equal(f.host.location.pathname, '/chat/saved-conversation');
});

test('executable and ambiguous URLs never become shallow or framework navigation targets', () => {
  const origin = 'https://getopenprism.com';
  for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'vbscript:alert(1)', 'file:///tmp/test', 'ftp://example.com/chat', 'https://user:secret@example.com/chat', '/\\example.com/chat', '\n/chat', '/chat\u0000', ' chat', 'chat']) {
    assert.deepEqual(resolveWorkspaceNavigation(href, origin), { kind: 'blocked' }, href);
  }
  assert.equal(resolveWorkspaceNavigation('/chat/%2f..%2fapi', origin).kind, 'router');
  assert.equal(resolveWorkspaceNavigation('/%63hat/a', origin).kind, 'router');
});

test('chat switching, Back and Forward preserve the shell history and framework metadata', () => {
  const f = fixture();
  initializeWorkspaceHistory(f.host);
  const markedState = f.host.history.state;
  assert.deepEqual(markedState.frameworkTree, f.initialMetadata.frameworkTree);
  assert.equal(markedState.scroll, 123);
  assert.equal(navigateWorkspaceHistory(f.host, '/chat/b', f.onPathname), true);
  assert.equal(navigateWorkspaceHistory(f.host, '/chat/c', f.onPathname), true);
  assert.equal(f.entries.length, 3);
  assert.deepEqual(f.traverse(-1), { restored: true, stopped: true });
  assert.equal(f.host.location.pathname, '/chat/b');
  assert.deepEqual(f.traverse(-1), { restored: true, stopped: true });
  assert.equal(f.host.location.pathname, '/chat/a');
  assert.deepEqual(f.traverse(1), { restored: true, stopped: true });
  assert.equal(f.host.location.pathname, '/chat/b');
  assert.deepEqual(f.changes, ['/chat/b', '/chat/c', '/chat/b', '/chat/a', '/chat/b']);
  assert.ok(f.entries.every(entry => entry.state.frameworkTree.slot === 'workspace'));
  assert.deepEqual(f.writes, ['replace', 'push', 'push', 'replace', 'replace', 'replace']);
});

test('replace and repeated selections avoid extra entries, including initial untagged history', () => {
  const f = fixture('/chat');
  assert.equal(navigateWorkspaceHistory(f.host, '/chat/a', f.onPathname, { replace: true }), true);
  assert.equal(f.entries.length, 1);
  assert.equal(navigateWorkspaceHistory(f.host, '/chat/a', f.onPathname), true);
  assert.equal(f.entries.length, 1);
  assert.deepEqual(f.writes, ['replace', 'replace']);
  assert.equal(navigateWorkspaceHistory(f.host, '/chat/a?source=search#latest', f.onPathname), true);
  assert.equal(f.entries.length, 2);
  assert.equal(f.host.location.search, '?source=search');
  assert.equal(f.host.location.hash, '#latest');
});

test('non-workspace destinations and untagged history leave the framework in control', () => {
  const f = fixture();
  for (const href of ['/signin-with-chatgpt', '/api/chat', 'https://example.com/chat', 'javascript:alert(1)']) {
    assert.equal(navigateWorkspaceHistory(f.host, href, f.onPathname), false);
  }
  assert.equal(f.writes.length, 0);
  assert.equal(f.changes.length, 0);
  let stopped = false;
  assert.equal(restoreWorkspaceHistory(f.host, { state: null, stopImmediatePropagation() { stopped = true; } }, f.onPathname), false);
  assert.equal(stopped, false);
  initializeWorkspaceHistory(f.host);
  const markedState = f.host.history.state;
  f.host.history.pushState(markedState, '', '/signin-with-chatgpt');
  assert.equal(restoreWorkspaceHistory(f.host, { state: markedState, stopImmediatePropagation() { stopped = true; } }, f.onPathname), false);
  assert.equal(stopped, false);
});

test('new-chat shortcut works from physical Korean keys and ignores composing/repeated/conflicting keys', () => {
  const event = { ctrlKey: true, metaKey: false, shiftKey: true, key: 'O', code: 'KeyO' };
  assert.equal(isNewChatShortcut(event), true);
  assert.equal(isNewChatShortcut({ ...event, ctrlKey: false, metaKey: true }), true);
  assert.equal(isNewChatShortcut({ ...event, key: 'ㅐ' }), true);
  assert.equal(isNewChatShortcut({ ...event, key: 'o', code: undefined }), true);
  for (const patch of [{ ctrlKey: false }, { shiftKey: false }, { altKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { key: 'P', code: 'KeyP' }]) {
    assert.equal(isNewChatShortcut({ ...event, ...patch }), false);
  }
});
