import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const directory = new URL('../.sites-runtime/upgrade-client-tests/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const [name, sourcePath] of [
  ['return-state', '../components/upgrade/return-state.ts'],
  ['api', '../components/upgrade/api.ts'],
  ['toss-client', '../lib/toss-client.ts'],
  ['billing-sync', '../lib/billing-sync.ts'],
]) {
  const source = await readFile(new URL(sourcePath, import.meta.url), 'utf8');
  await writeFile(new URL(`${name}.mjs`, directory), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}
const returns = await import(new URL('return-state.mjs', directory).href);
const api = await import(new URL('api.mjs', directory).href);
const sync = await import(new URL('billing-sync.mjs', directory).href);
const orderId = 'prism_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const callback = { orderId, paymentKey: 'payment_key_fixture', amount: 10_000, cancelled: false };
const query = (overrides = {}) => `?${new URLSearchParams({ orderId, paymentKey: callback.paymentKey, amount: '10000', ...overrides })}`;
const memoryStorage = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};

const globalNames = ['window', 'document', 'localStorage', 'sessionStorage', 'BroadcastChannel', 'fetch'];
const originalGlobals = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
function setGlobal(name, value) { Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); }
afterEach(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

test('callback parser accepts exact positive-KRW callbacks and keyless owned-order return paths', () => {
  assert.deepEqual(returns.parsePaymentReturn(query(), 'success'), callback);
  assert.deepEqual(returns.parsePaymentReturn(`?orderId=${orderId}`, 'success'), { orderId, cancelled: false });
  assert.deepEqual(returns.parsePaymentReturn(`?order=${orderId}&code=USER_CANCEL&message=untrusted`, 'fail'), { orderId, cancelled: true });
  assert.deepEqual(returns.parsePaymentReturn('?code=PAY_PROCESS_CANCELED', 'fail', orderId), { orderId, cancelled: true });
});

test('callback parser rejects nonpositive, noninteger, unsafe, or ambiguously encoded amounts', () => {
  for (const amount of ['', '0', '-1', '10.5', '1e4', 'NaN', 'Infinity', '9007199254740992', '10000000000000000', '010000', ' 10000']) {
    assert.throws(() => returns.parsePaymentReturn(query({ amount }), 'success'), undefined, `amount ${JSON.stringify(amount)} must fail`);
  }
  assert.throws(() => returns.parsePaymentReturn(`?orderId=${orderId}&amount=10000`, 'success'));
  assert.throws(() => returns.parsePaymentReturn(`?orderId=${orderId}&paymentKey=fixture`, 'success'));
});

test('duplicate parameters, mismatched merchant order references, and overlong keys cannot select an order', () => {
  for (const addition of ['&amount=50000', '&paymentKey=second', `&orderId=${orderId}`, '&order=another_order']) {
    assert.throws(() => returns.parsePaymentReturn(query() + addition, 'success'));
  }
  assert.throws(() => returns.parsePaymentReturn(`?order=${orderId}&order=${orderId}`, 'fail'));
  for (const value of ['', 'x'.repeat(201), 'key\nheader', 'key\u0000value']) assert.throws(() => returns.parsePaymentReturn(query({ paymentKey: value }), 'success'));
  for (const value of ['', 'short', '/other', 'x'.repeat(65)]) assert.throws(() => returns.parsePaymentReturn(query({ orderId: value }), 'success'));
});

test('same-tab handoff restores only the exact order and purges itself at the ten-minute boundary', () => {
  const storage = memoryStorage();
  assert.equal(returns.storePaymentReturn(storage, callback, 1000), true);
  assert.deepEqual(returns.readPaymentReturn(storage, orderId, 1000 + returns.PAYMENT_RETURN_TTL_MS - 1), callback);
  assert.equal(returns.readPaymentReturn(storage, 'prism_other_order', 1001), null);
  assert.equal(storage.values.size, 1, 'looking up another order must not erase this callback');
  assert.equal(returns.readPaymentReturn(storage, orderId, 1000 + returns.PAYMENT_RETURN_TTL_MS), null);
  assert.equal(storage.values.size, 0, 'expired payment keys must be deleted');
});

test('tampered, malformed, or future-dated handoffs are rejected and removed', () => {
  for (const replace of [
    value => ({ ...value, orderId: 'prism_different_order' }),
    value => ({ ...value, amount: -10000 }),
    value => ({ ...value, amount: 9007199254740992 }),
    value => ({ ...value, paymentKey: 'x'.repeat(201) }),
    value => ({ ...value, createdAt: 2000 }),
  ]) {
    const storage = memoryStorage();
    returns.storePaymentReturn(storage, callback, 1000);
    const key = [...storage.values.keys()][0];
    storage.setItem(key, JSON.stringify(replace(JSON.parse(storage.getItem(key)))));
    assert.equal(returns.readPaymentReturn(storage, orderId, 1001), null);
    assert.equal(storage.values.size, 0);
  }
  const storage = memoryStorage();
  returns.storePaymentReturn(storage, callback, 1000);
  storage.setItem([...storage.values.keys()][0], '{broken');
  assert.equal(returns.readPaymentReturn(storage, orderId, 1001), null);
  assert.equal(storage.values.size, 0);
});

test('storage denial is explicit and clearing a verified callback removes its key', () => {
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(returns.storePaymentReturn(denied, callback), false);
  assert.equal(returns.readPaymentReturn(denied, orderId), null);
  assert.doesNotThrow(() => returns.clearPaymentReturn(denied, orderId));
  assert.equal(returns.storePaymentReturn(null, callback), false);
  const storage = memoryStorage();
  returns.storePaymentReturn(storage, callback);
  returns.clearPaymentReturn(storage, orderId);
  assert.equal(storage.values.size, 0);
});

test('authentication return URLs contain only a known route and order/product ID, never a payment key', () => {
  const returnPath = returns.paymentAuthReturnPath('success', orderId);
  const auth = new URL(api.upgradeSignInHref(returnPath), 'https://merchant.example');
  assert.equal(auth.pathname, '/signin-with-chatgpt');
  assert.equal(auth.searchParams.get('return_to'), `/upgrade/success?orderId=${orderId}`);
  for (const value of [
    `/upgrade/success?orderId=${orderId}&paymentKey=${callback.paymentKey}&amount=10000`,
    `/upgrade/fail?orderId=${orderId}&message=${callback.paymentKey}`,
  ]) {
    const destination = new URL(api.upgradeSignInHref(value), 'https://merchant.example').searchParams.get('return_to');
    assert.equal(destination.includes('paymentKey'), false);
    assert.equal(destination.includes(callback.paymentKey), false);
    assert.equal(destination.includes('amount'), false);
  }
  for (const unsafe of ['https://outside.example/upgrade', '//outside.example/upgrade', 'https://[invalid', '/signin-with-chatgpt?return_to=/upgrade', '/upgrade/elsewhere']) {
    assert.equal(new URL(api.upgradeSignInHref(unsafe), 'https://merchant.example').searchParams.get('return_to'), '/upgrade');
  }
  assert.equal(returns.paymentAuthReturnPath('success', '../outside'), '/upgrade');
  assert.equal(returns.paymentAuthReturnPath('//outside.example', orderId), '/upgrade');
  assert.equal(new URL(api.upgradeSignInHref('/upgrade?product=credits-10000&paymentKey=secret'), 'https://merchant.example').searchParams.get('return_to'), '/upgrade?product=credits-10000');
});

test('API errors and invalid JSON never become a payment success value', async () => {
  setGlobal('fetch', async () => Response.json({ error: 'Payment key is required.', code: 'PAYMENT_KEY_REQUIRED' }, { status: 409 }));
  await assert.rejects(() => api.upgradeRequest('payments/reconcile', { orderId }), error => error instanceof api.UpgradeApiError && error.status === 409 && error.code === 'PAYMENT_KEY_REQUIRED');
  setGlobal('fetch', async () => new Response('<html>gateway failure</html>', { status: 502 }));
  await assert.rejects(() => api.upgradeRequest('payments/confirm', callback), error => error instanceof api.UpgradeApiError && error.status === 502);
  setGlobal('fetch', async () => Response.json(null));
  await assert.rejects(() => api.upgradeRequest('upgrade'), error => error instanceof api.UpgradeApiError);
});

function fakeSdkBrowser() {
  const scripts = [];
  setGlobal('window', {});
  setGlobal('document', {
    createElement(tag) {
      assert.equal(tag, 'script');
      return { dataset: {}, onload: null, onerror: null, removed: false, remove() { this.removed = true; } };
    },
    head: { appendChild(script) { scripts.push(script); } },
  });
  return scripts;
}

test('SDK loader deduplicates concurrent loads and returns only a real provider factory', async () => {
  const sdk = await import(new URL('toss-client.mjs?deduplicate', directory).href);
  const scripts = fakeSdkBrowser();
  const first = sdk.loadTossPayments(), second = sdk.loadTossPayments();
  assert.equal(first, second);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, 'https://js.tosspayments.com/v2/standard');
  assert.equal(scripts[0].referrerPolicy, 'no-referrer');
  const factory = () => { throw new Error('The factory is not invoked by loading alone.'); };
  window.TossPayments = factory;
  scripts[0].onload();
  assert.equal(await first, factory);
  assert.equal(await second, factory);
});

test('SDK transport failure and an onload without the factory reject and permit a clean retry', async () => {
  const sdk = await import(new URL('toss-client.mjs?retry', directory).href);
  const scripts = fakeSdkBrowser();
  const first = sdk.loadTossPayments();
  scripts[0].onerror();
  await assert.rejects(first, /네트워크/);
  assert.equal(scripts[0].removed, true);
  const second = sdk.loadTossPayments();
  window.TossPayments = {};
  scripts[1].onload();
  await assert.rejects(second, /불러오지/);
  assert.equal(scripts[1].removed, true);
  const third = sdk.loadTossPayments();
  const factory = () => ({});
  window.TossPayments = factory;
  scripts[2].onload();
  assert.equal(await third, factory);
});

test('cross-tab payloads only invalidate data; no supplied balance is passed to subscribers', async () => {
  const channels = [];
  const sent = [];
  class FakeChannel {
    constructor(name) { this.name = name; channels.push(this); }
    postMessage(message) { sent.push(message); for (const channel of channels) if (channel !== this && !channel.closed) channel.onmessage?.({ data: message }); }
    close() { this.closed = true; }
  }
  setGlobal('BroadcastChannel', FakeChannel);
  setGlobal('window', new EventTarget());
  const documentTarget = new EventTarget();
  documentTarget.visibilityState = 'visible';
  setGlobal('document', documentTarget);
  setGlobal('localStorage', memoryStorage());
  const calls = [];
  const unsubscribe = sync.subscribeBillingUpdates((...args) => calls.push(args));
  channels[0].onmessage({ data: { type: 'unrelated', balance: 500000000000 } });
  await new Promise(resolve => setTimeout(resolve, 115));
  assert.deepEqual(calls, []);
  channels[0].onmessage({ data: { type: sync.BILLING_UPDATED_EVENT, balance: 500000000000, paymentKey: 'untrusted' } });
  await new Promise(resolve => setTimeout(resolve, 115));
  assert.deepEqual(calls, [[]]);
  sync.notifyBillingUpdated();
  await new Promise(resolve => setTimeout(resolve, 115));
  assert.deepEqual(sent, [{ type: sync.BILLING_UPDATED_EVENT }]);
  assert.deepEqual(calls, [[], []]);
  unsubscribe();
  window.dispatchEvent(new Event(sync.BILLING_UPDATED_EVENT));
  await new Promise(resolve => setTimeout(resolve, 115));
  assert.equal(calls.length, 2);
});
