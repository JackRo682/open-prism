import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

// Run the actual component callbacks with deterministic lifecycle/SDK fixtures.
// This verifies callback races; it does not substitute for browser/OAuth QA.
const runtime = new URL('../.sites-runtime/drive-dialog-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
await writeFile(new URL('fixture.mjs', runtime), `
export const jsx = (type, props) => ({type, props});
export const jsxs = jsx;
export const Fragment = 'Fragment';
export const useState = initial => globalThis.__driveDialogHarness.useState(initial);
export const useRef = initial => globalThis.__driveDialogHarness.useRef(initial);
export const useEffect = (effect, deps) => globalThis.__driveDialogHarness.useEffect(effect, deps);
export const prismApiFetch = (...args) => globalThis.__driveDialogHarness.apiFetch(...args);
export const Dialog = Object.fromEntries(['Root', 'Portal', 'Overlay', 'Content', 'Title', 'Close', 'Description'].map(name => [name, 'Dialog.' + name]));
export const AlertCircle='AlertCircle', ArrowRight='ArrowRight', Cloud='Cloud', LoaderCircle='LoaderCircle', X='X', CheckCircle2='CheckCircle2', Copy='Copy', ExternalLink='ExternalLink', FileText='FileText';
export const findModel=()=>null, PROVIDERS={}, gmailComposeUrl=()=>'';
`);
for (const [target, path] of [
  ['drive-client', '../lib/drive-client.ts'],
  ['drive-picker', '../components/workspace/drive-picker.tsx'],
]) {
  const source = (await readFile(new URL(path, import.meta.url), 'utf8')).replace("import './integrations.css';", '')
    .replace(/\bfetch\((['"])\/api\//g, 'globalThis.__driveDialogHarness.apiFetch($1/api/');
  let code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  code = code.replace(/(['"])(react\/jsx-runtime|react|radix-ui|lucide-react|\.\.\/\.\.\/lib\/(?:client-api|models|conversation-export))\1/g, "'./fixture.mjs'")
    .replace("'../../lib/drive-client'", "'./drive-client.mjs'");
  // Main uses direct fetch for the configuration route; keep that network boundary in the fixture.
  if (target === 'drive-picker') code = "import { prismApiFetch } from './fixture.mjs';\n" + code.replace("fetch('/api/integrations/drive'", "prismApiFetch('/api/integrations/drive'");
  await writeFile(new URL(target + '.mjs', runtime), code);
}
const { DrivePickerDialog } = await import(new URL('drive-picker.mjs', runtime));
const tokenValue = 'ya29.only-for-this-component-fixture';
const scope = 'https://www.googleapis.com/auth/drive.file';
const grant = () => ({ access_token: tokenValue, scope, expires_in: 3600, token_type: 'Bearer' });
const globals = new Map(['window', 'document', 'localStorage', 'sessionStorage', '__driveDialogHarness'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const replaceGlobal = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const mountedHarnesses = [];
afterEach(() => {
  for (const harness of mountedHarnesses.splice(0)) harness.unmount();
  for (const [name, original] of globals) { if (original) Object.defineProperty(globalThis, name, original); else delete globalThis[name]; }
});

function setup(t, component = DrivePickerDialog, properties = {}) {
  const auth = [], pickers = [], apiCalls = [], uploaded = [], closed = [];
  const browser = Object.assign(new EventTarget(), { location: { origin: 'https://getopenprism.com' }, innerWidth: 1200, innerHeight: 800, setTimeout, clearTimeout, gapi: {} });
  class DocsView {
    setMimeTypes() { return this; } setMode() { return this; } setIncludeFolders() { return this; } setSelectFolderEnabled() { return this; }
  }
  class PickerBuilder {
    addView() { return this; } setOAuthToken(token) { this.token = token; return this; }
    setDeveloperKey() { return this; } setAppId() { return this; } setOrigin() { return this; } setLocale() { return this; } setSize() { return this; }
    setCallback(callback) { this.callback = callback; return this; }
    build() {
      const picker = { callback: this.callback, visible: false, disposed: false, setVisible(value) { this.visible = value; }, dispose() { this.disposed = true; } };
      pickers.push(picker); return picker;
    }
  }
  browser.google = {
    accounts: { oauth2: {
      initTokenClient(config) { auth.push(config); return { requestAccessToken() {} }; },
      hasGrantedAllScopes: response => response.scope?.split(' ').includes(scope),
    } },
    picker: { PickerBuilder, DocsView, ViewId: { DOCS: 'docs' }, DocsViewMode: { LIST: 'list' }, Action: { PICKED: 'picked', CANCEL: 'cancel' } },
  };
  replaceGlobal('window', browser); replaceGlobal('document', {});
  const storage = new Proxy({}, { get() { throw new Error('OAuth must never access browser persistence'); } });
  replaceGlobal('localStorage', storage); replaceGlobal('sessionStorage', storage);
  const harness = {
    hooks: [], cursor: 0, effects: [], dirty: true, mounted: true, tree: null,
    props: { open: true, signedIn: true, onOpenChange: value => closed.push(value), onFile: async file => uploaded.push(file), onNavigate() {}, ...properties },
    useState(initial) {
      const index = this.cursor++;
      const state = this.hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [state.value, next => { if (!this.mounted) return; state.value = typeof next === 'function' ? next(state.value) : next; this.dirty = true; }];
    },
    useRef(initial) { const index = this.cursor++; return this.hooks[index] ??= { current: initial }; },
    useEffect(effect, deps) {
      const index = this.cursor++, previous = this.hooks[index];
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      this.effects.push(() => { previous?.cleanup?.(); this.hooks[index] = { deps, cleanup: effect() }; });
    },
    async apiFetch(url, init) { apiCalls.push({ url, init }); return Response.json({ configured: true, clientId: 'fixture.apps.googleusercontent.com', developerKey: 'public-picker-key', appId: '12345' }); },
    render(props = {}) {
      if (!this.mounted) return;
      Object.assign(this.props, props); this.cursor = 0; this.effects = []; this.dirty = false;
      replaceGlobal('__driveDialogHarness', this);
      this.tree = component(this.props);
      for (const effect of this.effects) effect();
    },
    async flush() {
      for (let i = 0; i < 8; i++) { await new Promise(resolve => setImmediate(resolve)); if (this.dirty && this.mounted) this.render(); }
    },
    unmount() { if (!this.mounted) return; this.mounted = false; for (const hook of this.hooks) hook?.cleanup?.(); },
  };
  mountedHarnesses.push(harness); harness.render();
  const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : '';
  const nodes = node => !node ? [] : Array.isArray(node) ? node.flatMap(nodes) : typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [];
  const connect = () => {
    const button = nodes(harness.tree).find(node => node.type === 'button' && /Google 계정 연결|Google 연결 후 내보내기/.test(text(node)));
    assert.ok(button, 'connect action is rendered'); assert.equal(button.props.disabled, false);
    button.props.onClick(); return button.props.onClick;
  };
  return { harness, connect, auth, pickers, apiCalls, uploaded, closed, browser, text: () => text(harness.tree) };
}

test('picker guards duplicate clicks, stale OAuth callbacks, duplicate results, and cancel/reopen', async t => {
  const f = setup(t); await f.harness.flush();
  const click = f.connect(); click(); assert.equal(f.auth.length, 1, 'a ref guard closes the React state-update race');
  f.harness.render({ open: false }); await f.harness.flush();
  f.harness.render({ open: true }); await f.harness.flush(); f.connect(); assert.equal(f.auth.length, 2);
  const stale = grant(); f.auth[0].callback(stale); assert.equal(stale.access_token, undefined); assert.equal(f.pickers.length, 0);
  const current = grant(); f.auth[1].callback(current); assert.equal(current.access_token, undefined); assert.equal(f.pickers.length, 1);
  const duplicate = grant(); f.auth[1].callback(duplicate); assert.equal(duplicate.access_token, undefined); assert.equal(f.pickers.length, 1);
  f.pickers[0].callback({ action: 'cancel' }); assert.equal(f.pickers[0].disposed, true);
  await f.harness.flush(); f.connect(); assert.equal(f.auth.length, 3, 'cancel discards the cached grant and requires a new request');
  f.auth[2].callback(grant()); assert.equal(f.pickers.length, 2);
  f.pickers[0].callback({ action: 'cancel' }); assert.equal(f.pickers[1].disposed, false, 'a late old picker callback cannot dispose the new picker');
  assert.ok(f.auth.every(config => config.scope === scope && config.include_granted_scopes === false));
  assert.ok(f.apiCalls.every(call => !new Headers(call.init.headers).has('Authorization') && !JSON.stringify(call).includes(tokenValue)));
});

test('a picked file uploads once, and the Google bearer never reaches the application callback', async t => {
  const f = setup(t); let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1
    ? Response.json({ id: 'file1', name: 'safe.txt', mimeType: 'text/plain', size: '5', capabilities: { canDownload: true } }) : new Response('hello'));
  await f.harness.flush(); f.connect(); const response = grant(); f.auth[0].callback(response);
  const result = { action: 'picked', docs: [{ id: 'file1' }] };
  f.pickers[0].callback(result); f.pickers[0].callback(result);
  await f.harness.flush();
  assert.equal(requests, 2); assert.equal(f.uploaded.length, 1); assert.equal(await f.uploaded[0].text(), 'hello');
  assert.equal(response.access_token, undefined); assert.deepEqual(f.closed, [false]);
});

test('picker unmount clears pending OAuth results and aborts an active transfer', async t => {
  const pending = setup(t); await pending.harness.flush(); pending.connect(); pending.harness.unmount();
  const stale = grant(); pending.auth[0].callback(stale);
  assert.equal(stale.access_token, undefined); assert.equal(pending.pickers.length, 0);
  const active = setup(t); await active.harness.flush(); let transferSignal;
  t.mock.method(globalThis, 'fetch', (_url, init) => new Promise((_resolve, reject) => {
    transferSignal = init.signal; init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  active.connect(); active.auth[0].callback(grant()); active.pickers[0].callback({ action: 'picked', docs: [{ id: 'file1' }] });
  assert.ok(transferSignal); active.harness.unmount(); assert.equal(transferSignal.aborted, true);
  await active.harness.flush(); assert.equal(active.uploaded.length, 0); assert.deepEqual(active.closed, []);
});

test('pagehide discards an open picker grant before history can retain the page', async t => {
  const f = setup(t); await f.harness.flush(); f.connect(); f.auth[0].callback(grant());
  f.browser.dispatchEvent(new Event('pagehide')); assert.equal(f.pickers[0].disposed, true);
  await f.harness.flush(); f.connect(); assert.equal(f.auth.length, 2);
});
