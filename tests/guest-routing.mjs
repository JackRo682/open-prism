import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const directory = new URL('../.sites-runtime/guest-routing/', import.meta.url);
await mkdir(directory, { recursive: true });
globalThis.__guestRouteTest = { user: null, env: {} };
await writeFile(new URL('stubs.mjs', directory), `
export const env = globalThis.__guestRouteTest.env;
export const Workspace = () => null;
export const GuestWorkspace = () => null;
export const PublicPage = () => null;
export const PublicSharePage = () => null;
export const getChatGPTUser = async () => globalThis.__guestRouteTest.user;
export const chatGPTSignInPath = path => '/signin-with-chatgpt?return_to=' + encodeURIComponent(path);
export const redirect = path => { throw new Error('REDIRECT:' + path); };
export const requireChatGPTUser = async path => { if (!globalThis.__guestRouteTest.user) redirect(chatGPTSignInPath(path)); return globalThis.__guestRouteTest.user; };
`);
const startupModules = ['models', 'workspace-tools', 'workspace-bootstrap', 'workspace-startup', 'schedule-runner'];
for (const name of startupModules) {
  let code = await readFile(new URL('../lib/' + name + '.ts', import.meta.url), 'utf8');
  for (const dependency of startupModules) code = code.replaceAll("'./" + dependency + "'", "'./" + dependency + ".mjs'");
  await writeFile(new URL(name + '.mjs', directory), ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
for (const [source, target] of [['app/page.tsx', 'home.mjs'], ['app/[...path]/page.tsx', 'route.mjs']]) {
  let code = await readFile(new URL('../' + source, import.meta.url), 'utf8');
  code = code.replace(/import Workspace from [^;]+;/, "import { Workspace } from './stubs.mjs';")
    .replace(/import GuestWorkspace from [^;]+;/, "import { GuestWorkspace } from './stubs.mjs';")
    .replace(/import PublicPage, \{ PublicSharePage \} from [^;]+;/, "import { PublicPage, PublicSharePage } from './stubs.mjs';")
    .replace(/from ['"](?:\.\.\/|\.\/)?chatgpt-auth['"]/, "from './stubs.mjs'")
    .replace(/from ['"]cloudflare:workers['"]/, "from './stubs.mjs'")
    .replace(/from ['"](?:\.\.\/)+lib\/workspace-startup['"]/, "from './workspace-startup.mjs'")
    .replace(/from 'next\/navigation'/, "from './stubs.mjs'");
  await writeFile(new URL(target, directory), ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText);
}
const home = await import(new URL('home.mjs', directory));
const route = await import(new URL('route.mjs', directory));
const stubs = await import(new URL('stubs.mjs', directory));
const page = (...path) => route.default({ params: Promise.resolve({ path }) });

test('server resolves guest and signed-in shells without a shared cached page', async () => {
  assert.equal(home.dynamic, 'force-dynamic'); assert.equal(route.dynamic, 'force-dynamic');
  globalThis.__guestRouteTest.user = null;
  assert.equal((await home.default()).type, stubs.GuestWorkspace);
  assert.equal((await page('chat')).type, stubs.GuestWorkspace);
  globalThis.__guestRouteTest.user = { userId: 'owner', email: 'owner@example.test' };
  assert.equal((await home.default()).type, stubs.Workspace);
  assert.equal((await page('chat')).type, stubs.Workspace);
  assert.equal((await page('history')).type, stubs.Workspace);
  assert.equal((await page('share', 'a'.repeat(64))).type, stubs.Workspace);
});

test('signed-in workspace receives the exact initial route before hydration', async () => {
  globalThis.__guestRouteTest.user = { userId: 'owner', email: 'owner@example.test' };
  const root = await home.default();
  assert.equal(root.type, stubs.Workspace);
  assert.equal(root.props.initialPathname, '/');
  assert.deepEqual(root.props.initialBootstrap.user, { name: 'owner', email: 'owner@example.test' });
  assert.equal(root.key, 'owner');
  for (const segments of [
    ['chat'], ['chat', '646154a1-3edf-40ba-a2b2-0c6bf6d099e1'],
    ['history'], ['customize', 'skills'], ['share', 'a'.repeat(64)],
  ]) {
    const result = await page(...segments);
    assert.equal(result.type, stubs.Workspace);
    assert.equal(result.props.initialPathname, '/' + segments.map(encodeURIComponent).join('/'));
    assert.deepEqual(result.props.initialBootstrap.user, { name: 'owner', email: 'owner@example.test' });
    assert.equal(result.key, 'owner');
  }
});

test('server route seeds only the current account history and resets the workspace identity when accounts change', async () => {
  const env = globalThis.__guestRouteTest.env;
  env.BETA_MODE = 'true';
  env.OPENAI_API_KEY = 'server-only-fixture-key';
  env.DB = {
    prepare() {
      return { bind(owner) { return { async all() { return { results: [{ id: owner + '-chat', title: owner + ' history', model: 'gpt-6.1-sol', created_at: 1, updated_at: 2 }] }; } }; } };
    },
  };
  try {
    for (const owner of ['alice', 'bob']) {
      globalThis.__guestRouteTest.user = { userId: owner, email: owner + '@example.test', fullName: owner.toUpperCase() };
      for (const element of [await home.default(), await page('chat'), await page('history')]) {
        assert.equal(element.key, owner);
        assert.deepEqual(element.props.initialBootstrap.user, { name: owner.toUpperCase(), email: owner + '@example.test' });
        assert.equal(element.props.initialBootstrap.providers.openai.configured, true);
        assert.deepEqual(element.props.initialChats.map(chat => chat.id), [owner + '-chat']);
        assert.equal(JSON.stringify(element.props).includes(env.OPENAI_API_KEY), false);
      }
    }
  } finally {
    for (const key of Object.keys(env)) delete env[key];
  }
});

test('guest and redirected requests never start a private history query', async () => {
  let reads = 0;
  globalThis.__guestRouteTest.user = null;
  globalThis.__guestRouteTest.env.DB = { prepare() { reads++; throw new Error('Private history must not be queried'); } };
  try {
    assert.equal((await home.default()).type, stubs.GuestWorkspace);
    assert.equal((await page('chat')).type, stubs.GuestWorkspace);
    await assert.rejects(() => page('history'), /REDIRECT:/);
    assert.equal(reads, 0);
  } finally { delete globalThis.__guestRouteTest.env.DB; }
});

test('anonymous deep links require authentication and retain a safe return path', async () => {
  globalThis.__guestRouteTest.user = null;
  for (const path of [['history'], ['settings'], ['chat', 'private-conversation'], ['files'], ['customize', 'skills']]) {
    await assert.rejects(() => page(...path), { message: 'REDIRECT:' + stubs.chatGPTSignInPath('/' + path.join('/')) });
  }
});

test('guest information and public shares remain accessible without the workspace', async () => {
  globalThis.__guestRouteTest.user = null;
  for (const path of ['about', 'privacy', 'terms', 'faq', 'help', 'docs']) assert.equal((await page(path)).type, stubs.PublicPage);
  assert.equal((await page('share', 'a'.repeat(64))).type, stubs.PublicSharePage);
  await assert.rejects(() => page('privacy', 'private'), /REDIRECT:/);
  await assert.rejects(() => page('login'), /REDIRECT:\/signin-with-chatgpt\?return_to=%2Fchat/);
});
