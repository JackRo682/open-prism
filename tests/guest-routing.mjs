import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const directory = new URL('../.sites-runtime/guest-routing/', import.meta.url);
await mkdir(directory, { recursive: true });
globalThis.__guestRouteTest = { user: null };
await writeFile(new URL('stubs.mjs', directory), `
export const Workspace = () => null;
export const GuestWorkspace = () => null;
export const PublicPage = () => null;
export const PublicSharePage = () => null;
export const getChatGPTUser = async () => globalThis.__guestRouteTest.user;
export const chatGPTSignInPath = path => '/signin-with-chatgpt?return_to=' + encodeURIComponent(path);
export const redirect = path => { throw new Error('REDIRECT:' + path); };
export const requireChatGPTUser = async path => { if (!globalThis.__guestRouteTest.user) redirect(chatGPTSignInPath(path)); return globalThis.__guestRouteTest.user; };
`);
for (const [source, target] of [['app/page.tsx', 'home.mjs'], ['app/[...path]/page.tsx', 'route.mjs']]) {
  let code = await readFile(new URL('../' + source, import.meta.url), 'utf8');
  code = code.replace(/import Workspace from [^;]+;/, "import { Workspace } from './stubs.mjs';")
    .replace(/import GuestWorkspace from [^;]+;/, "import { GuestWorkspace } from './stubs.mjs';")
    .replace(/import PublicPage, \{ PublicSharePage \} from [^;]+;/, "import { PublicPage, PublicSharePage } from './stubs.mjs';")
    .replace(/from ['"](?:\.\.\/|\.\/)?chatgpt-auth['"]/, "from './stubs.mjs'")
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
