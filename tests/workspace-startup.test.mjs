import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Execute the real startup helpers and API against SQLite. Only the deployed
// Cloudflare/auth boundary is replaced; no remote service or real user is used.
const runtime = new URL('../.sites-runtime/workspace-startup-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
let user, sqlite, readOverride;
const env = {};
globalThis.__workspaceStartupTest = { env, getChatGPTUser: async () => user };
await writeFile(new URL('context.mjs', runtime), 'export const {env,getChatGPTUser}=globalThis.__workspaceStartupTest;');
const modules = ['models', 'provider', 'chat-title', 'billing-contract', 'billing', 'beta', 'workspace-settings', 'workspace-tools', 'workspace-bootstrap', 'workspace-startup', 'conversation-actions', 'chat-generation', 'media-provider', 'media-workspace', 'browser-workspace', 'scheduled-tasks', 'schedule-time', 'work-artifacts', 'regenerate-style', 'guest-chat', 'guest-import', 'request-security', 'request-lease', 'schedule-runner', 'security-monitoring', 'account-deletion', 'upload-validation', 'image-validation', 'public-shares', 'upload-security', 'api-resource-guards'];
for (const [source, target] of [...modules.map(name => ['lib/' + name + '.ts', name + '.mjs']), ['app/api/[...path]/route.ts', 'route.mjs']]) {
  let code = (await readFile(new URL('../' + source, import.meta.url), 'utf8'))
    .replaceAll("'cloudflare:workers'", "'./context.mjs'")
    .replaceAll("'../../chatgpt-auth'", "'./context.mjs'");
  for (const name of modules) code = code.replaceAll("'../../../lib/" + name + "'", "'./" + name + ".mjs'").replaceAll("'./" + name + "'", "'./" + name + ".mjs'");
  await writeFile(new URL(target, runtime), ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const { buildWorkspaceBootstrap } = await import(new URL('workspace-bootstrap.mjs', runtime));
const { loadWorkspaceStartup, listWorkspaceConversations } = await import(new URL('workspace-startup.mjs', runtime));
const route = await import(new URL('route.mjs', runtime));
const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url)))
  .filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')));

// Keep the actual Workspace render and React hooks so dropping the server seed
// causes a visible-render regression. Unrelated panels and navigation are inert;
// effects do not run during SSR, as on the first response before hydration.
await writeFile(new URL('use-copy-feedback.mjs', runtime), ts.transpileModule(
  await readFile(new URL('../hooks/use-copy-feedback.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText);
// The account trigger owns the visible server-seeded identity, so keep its
// actual component in this SSR boundary instead of replacing it with a stub.
await writeFile(new URL('account-popover.mjs', runtime), ts.transpileModule(
  await readFile(new URL('../components/workspace/account-popover.tsx', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } },
).outputText);
// Keep the real Suspense/error boundary: replacing it with an empty panel would
// discard the composer and history, invalidating the first-response assertions.
await writeFile(new URL('deferred-panel.mjs', runtime), ts.transpileModule(
  (await readFile(new URL('../components/workspace/deferred-panel.tsx', import.meta.url), 'utf8'))
    .replace("import './deferred-panel.css';", ''),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } },
).outputText);
let workspaceCode = await readFile(new URL('../app/workspace.tsx', import.meta.url), 'utf8');
const workspaceAst = ts.createSourceFile('workspace.tsx', workspaceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const replacements = [];
let stubIndex = 0;
for (const node of workspaceAst.statements) {
  if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
  const source = node.moduleSpecifier.text;
  if (!source.startsWith('.')) continue;
  if (!node.importClause) {
    replacements.push([node.getStart(), node.end, '']);
    continue;
  }
  if (node.importClause.isTypeOnly) continue;
  if (source === '../hooks/use-copy-feedback') {
    replacements.push([node.moduleSpecifier.getStart(), node.moduleSpecifier.end, JSON.stringify('./use-copy-feedback.mjs')]);
    continue;
  }
  if (source === '../components/workspace/account-popover') {
    replacements.push([node.moduleSpecifier.getStart(), node.moduleSpecifier.end, JSON.stringify('./account-popover.mjs')]);
    continue;
  }
  if (source === '../components/workspace/deferred-panel') {
    replacements.push([node.moduleSpecifier.getStart(), node.moduleSpecifier.end, JSON.stringify('./deferred-panel.mjs')]);
    continue;
  }
  const moduleName = source.replace(/^\.\.\/lib\//, '');
  if (modules.includes(moduleName)) {
    replacements.push([node.moduleSpecifier.getStart(), node.moduleSpecifier.end, JSON.stringify('./' + moduleName + '.mjs')]);
    continue;
  }
  const stubName = 'workspace-ui-' + stubIndex++ + '.mjs';
  const exports = ['export default function UnrelatedPanel() { return null; }'];
  const names = node.importClause.namedBindings;
  if (names && ts.isNamedImports(names)) for (const item of names.elements) {
    if (item.isTypeOnly) continue;
    const name = (item.propertyName || item.name).text;
    if (name === 'useWorkspaceNavigation') exports.push('export const useWorkspaceNavigation = (pathname = "/") => ({ pathname, navigate() {} });');
    else if (name === 'Composer') exports.push('export const Composer = props => React.createElement("div", { "data-testid": "startup-composer", "data-ready": String(props.ready), "data-signed-in": String(props.signedIn) });');
    else exports.push('export const ' + name + ' = () => null;');
  }
  await writeFile(new URL(stubName, runtime), "import React from 'react';\n" + exports.join('\n'));
  replacements.push([node.moduleSpecifier.getStart(), node.moduleSpecifier.end, JSON.stringify('./' + stubName)]);
}
for (const [start, end, replacement] of replacements.sort((a, b) => b[0] - a[0])) workspaceCode = workspaceCode.slice(0, start) + replacement + workspaceCode.slice(end);
await writeFile(new URL('workspace.mjs', runtime), ts.transpileModule(workspaceCode, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText);
const { default: Workspace } = await import(new URL('workspace.mjs', runtime));

const alice = { userId: 'alice', fullName: 'Alice Example', displayName: 'Alice Example', email: 'alice@example.test' };
const bob = { userId: 'bob', fullName: 'Bob Example', displayName: 'Bob Example', email: 'bob@example.test' };
const originalFetch = globalThis.fetch;
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const migration of migrations) sqlite.exec(migration);
  for (const key of Object.keys(env)) delete env[key];
  user = alice; readOverride = undefined;
  env.DB = {
    prepare(query) {
      let params = [];
      return {
        bind(...values) { params = values; return this; },
        async all() { return readOverride ? readOverride(query, params) : { results: sqlite.prepare(query).all(...params) }; },
        async first() { return sqlite.prepare(query).get(...params) ?? null; },
        async run() { return { success: true, meta: { changes: Number(sqlite.prepare(query).run(...params).changes) } }; },
      };
    },
  };
  globalThis.fetch = async () => { throw new Error('Startup must not make a client/bootstrap or provider HTTP request'); };
});
afterEach(() => { sqlite.close(); globalThis.fetch = originalFetch; });

function seed(owner, id, title, updated = 10) {
  sqlite.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, owner, title, 'gpt-6.1-sol', 1, updated);
  sqlite.prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)')
    .run(id + '-message', id, 'user', 'Private full message body for ' + owner, 1);
}
const get = path => route.GET(new Request('https://prism.test/api/' + path));
const render = (state, initialPathname = '/') => renderToStaticMarkup(React.createElement(Workspace, {
  initialPathname, initialBootstrap: state.bootstrap, initialChats: state.chats,
}));

test('server startup and bootstrap endpoint agree on user, provider and capability flags without exposing secrets', async () => {
  const secretConfig = {
    OPENAI_API_KEY: 'private-openai-fixture-key', ANTHROPIC_API_KEY: 'private-anthropic-fixture-key', GEMINI_API_KEY: 'private-gemini-fixture-key',
    BROWSERLESS_API_TOKEN: 'private-browser-fixture-token', SCHEDULE_RUNNER_SECRET: 'private-scheduled-runner-fixture-secret-123456',
    TOSS_SECRET_KEY: 'private-payment-fixture-key', GOOGLE_DRIVE_CLIENT_ID: 'private-drive-client-fixture',
    GOOGLE_DRIVE_PICKER_KEY: 'private-drive-picker-fixture', GOOGLE_DRIVE_APP_ID: 'private-drive-app-fixture',
  };
  const scenarios = [
    {},
    { ...secretConfig, BETA_MODE: 'true', SCHEDULE_RUNNER_ENABLED: 'true', ADMIN_USER_ID: alice.userId, BROWSERLESS_EGRESS_POLICY_VERIFIED: 'true' },
    { ...secretConfig, BETA_MODE: 'true', WEB_RESEARCH_ENABLED: 'false', WORK_CODE_EXECUTION_ENABLED: 'false', IMAGE_GENERATION_ENABLED: 'false', MUSIC_GENERATION_ENABLED: 'false', VIDEO_GENERATION_ENABLED: 'false', SCHEDULE_RUNNER_ENABLED: 'false' },
  ];
  for (const scenario of scenarios) {
    const database = env.DB;
    for (const key of Object.keys(env)) delete env[key];
    Object.assign(env, scenario, { DB: database });
    const startup = await loadWorkspaceStartup(alice, env);
    const response = await get('bootstrap');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), startup.bootstrap);
    assert.deepEqual(startup.bootstrap.user, { name: 'Alice Example', email: 'alice@example.test' });
    for (const provider of Object.values(startup.bootstrap.providers)) assert.equal(typeof provider.configured, 'boolean');
    const serialized = JSON.stringify(startup);
    for (const secret of Object.values(secretConfig)) assert.equal(serialized.includes(secret), false);
    assert.equal('userId' in startup.bootstrap.user, false);
    assert.equal(startup.bootstrap.capabilities.remoteBrowser, !!scenario.BROWSERLESS_API_TOKEN && scenario.BROWSERLESS_EGRESS_POLICY_VERIFIED === 'true');
    assert.equal('DB' in startup.bootstrap, false);
    assert.equal('environment' in startup.bootstrap, false);
  }
});

test('bootstrap grants admin state only to the configured verified owner and handles nameless or anonymous users', () => {
  env.ADMIN_USER_ID = bob.userId;
  assert.equal(buildWorkspaceBootstrap(alice, env).isAdmin, false);
  assert.equal(buildWorkspaceBootstrap(bob, env).isAdmin, true);
  assert.equal(buildWorkspaceBootstrap(null, env).isAdmin, false);
  assert.equal(buildWorkspaceBootstrap(null, env).user, null);
  assert.deepEqual(buildWorkspaceBootstrap({ ...alice, fullName: null }, env).user, { name: 'alice', email: alice.email });
});

test('concurrent startup requests and the history endpoint return only each owner’s current metadata', async () => {
  seed('alice', 'alice-older', 'Alice older title', 10);
  seed('bob', 'bob-chat', 'Bob private title', 20);
  seed('alice', 'alice-newer', 'Alice newer title', 30);
  const [aliceState, bobState] = await Promise.all([loadWorkspaceStartup(alice, env), loadWorkspaceStartup(bob, env)]);
  assert.deepEqual(aliceState.chats.map(chat => chat.id), ['alice-newer', 'alice-older']);
  assert.deepEqual(bobState.chats.map(chat => chat.id), ['bob-chat']);
  for (const [account, state] of [[alice, aliceState], [bob, bobState]]) {
    user = account;
    const response = await get('conversations');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(state.chats)));
    assert.equal(JSON.stringify(state).includes('Private full message body'), false);
  }
  assert.deepEqual(await listWorkspaceConversations(env.DB, "' OR 1=1 --"), []);
  sqlite.prepare('UPDATE conversations SET title=? WHERE id=?').run('Updated Alice title', 'alice-newer');
  const refreshed = await loadWorkspaceStartup(alice, env);
  assert.equal(refreshed.chats[0].title, 'Updated Alice title');
  assert.equal(aliceState.chats[0].title, 'Alice newer title', 'one request must not mutate another request snapshot');
});

test('initial history is bounded and newest first while a successful empty account remains distinguishable', async () => {
  for (let index = 0; index < 205; index++) seed('alice', 'chat-' + index, 'Title ' + index, index + 1);
  const state = await loadWorkspaceStartup(alice, env);
  assert.equal(state.chats.length, 200);
  assert.equal(state.chats[0].id, 'chat-204');
  assert.equal(state.chats.at(-1).id, 'chat-5');
  assert.deepEqual((await loadWorkspaceStartup(bob, env)).chats, []);
});

test('missing or failed history preserves the authenticated bootstrap and allows a later successful retry', async () => {
  seed('alice', 'alice-chat', 'Alice saved title');
  const database = env.DB;
  for (const unavailable of [undefined, { prepare() { throw new Error('Database unavailable'); } }]) {
    env.DB = unavailable;
    const state = await loadWorkspaceStartup(alice, env);
    assert.deepEqual(state.bootstrap.user, { name: 'Alice Example', email: 'alice@example.test' });
    assert.equal(state.chats, null);
  }
  env.DB = database;
  readOverride = async () => { throw new Error('Read rejected'); };
  const rejected = await loadWorkspaceStartup(alice, env);
  assert.equal(rejected.chats, null);
  assert.equal(rejected.bootstrap.user.email, alice.email);
  readOverride = undefined;
  assert.equal((await loadWorkspaceStartup(alice, env)).chats[0].id, 'alice-chat');
});

test('slow history cannot block the authenticated shell and a late rejection remains handled', { timeout: 1500 }, async () => {
  let rejectRead;
  readOverride = () => new Promise((resolve, reject) => { rejectRead = reject; });
  const state = await loadWorkspaceStartup(alice, env, 5);
  assert.equal(state.chats, null);
  assert.equal(state.bootstrap.user.email, alice.email);
  const html = render(state);
  assert.match(html, /Alice Example/);
  assert.match(html, /data-ready="true" data-signed-in="true"/);
  assert.doesNotMatch(html, /Prism에 로그인하고 시작하세요/);
  rejectRead(new Error('D1 failed after the render deadline'));
  await nextTurn();
  assert.equal(state.chats, null);
});

test('first server-rendered workspace includes the verified account and its chat titles before any browser effects', async () => {
  seed('alice', 'alice-chat', 'Alice immediately visible history');
  seed('bob', 'bob-chat', 'Bob private history');
  const html = render(await loadWorkspaceStartup(alice, env));
  assert.match(html, /<strong>Alice Example<\/strong>/);
  assert.match(html, /Alice immediately visible history/);
  assert.doesNotMatch(html, /Bob private history/);
  assert.doesNotMatch(html, /Prism에 로그인하고 시작하세요/);
  assert.doesNotMatch(html, /Prism 채팅 기록이 저장됩니다|활동 및 대화 관리/);
  assert.match(html, /data-ready="true" data-signed-in="true"/);
});

test('the signed-out settings shell keeps the sign-in notice without claiming saved history', () => {
  const html = render({ bootstrap: buildWorkspaceBootstrap(null, env), chats: [] }, '/settings');
  assert.match(html, /Prism에 로그인하고 시작하세요/);
  assert.match(html, /여기에서 로그인/);
  assert.doesNotMatch(html, /Prism 채팅 기록이 저장됩니다|활동 및 대화 관리/);
});

test('initial history HTML is identical across UTC and Korea at a local calendar-date boundary', async () => {
  const timestamp = Date.parse('2026-11-07T15:30:00Z');
  seed('alice', 'boundary-chat', 'History at the date boundary', timestamp);
  const state = await loadWorkspaceStartup(alice, env);
  const previousTimeZone = process.env.TZ;
  try {
    const output = ['UTC', 'Asia/Seoul'].map(timeZone => {
      process.env.TZ = timeZone;
      const localDate = new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const html = render(state, '/history');
      assert.match(html, /class="history-list"/);
      assert.match(html, /History at the date boundary/);
      assert.match(html, /Nov 7/);
      assert.doesNotMatch(html, /Nov 8/);
      return { localDate, html };
    });
    assert.deepEqual(output.map(item => item.localDate), ['Nov 7', 'Nov 8'], 'the fixture must cross midnight in the two host time zones');
    assert.equal(output[0].html, output[1].html, 'the initial render must not depend on the server or browser default time zone');
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});
