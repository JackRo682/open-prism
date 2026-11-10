import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import ts from 'typescript';

const directory = new URL('../.sites-runtime/billing-tests/', import.meta.url);
await mkdir(directory, { recursive: true });
const env = {};
globalThis.__prismBillingEnv = env;
await writeFile(new URL('context.mjs', directory), 'export const env = globalThis.__prismBillingEnv;');
for (const name of ['models', 'billing-contract', 'billing']) {
  let source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8');
  source = source.replaceAll("'cloudflare:workers'", "'./context.mjs'");
  for (const imported of ['models', 'billing-contract']) source = source.replaceAll(`'./${imported}'`, `'./${imported}.mjs'`);
  await writeFile(new URL(`${name}.mjs`, directory), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const billing = await import(new URL('billing.mjs', directory).href);
const { BILLING_PRODUCTS } = await import(new URL('billing-contract.mjs', directory).href);
const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')));
const originalFetch = globalThis.fetch;
const WON = 1_000_000;
const goodConfig = {
  rates: { 'gpt-6.1-sol': { input: 1000, output: 2000 } },
  refundPolicy: 'Test fixture: refund unused balance.', validityPolicy: 'Test fixture: no expiry.',
  registrationNumber: 'fixture-registration', address: 'Test fixture address', supportEmail: 'support@example.test',
};
const jsonRequest = (path, body, headers = {}) => new Request('https://prism.test/api/' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://prism.test', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const errorIs = (status, code) => error => error instanceof billing.BillingError && error.status === status && (!code || error.code === code);
function fixture({ mode = 'test', kind = 'widget', config = goodConfig } = {}) {
  for (const key of Object.keys(env)) delete env[key];
  if (mode !== 'disabled') {
    env.PAYMENTS_MODE = mode; env.TOSS_CLIENT_KEY = `${mode}_${kind === 'widget' ? 'g' : ''}ck_fixture-client`;
    env.TOSS_SECRET_KEY = `${mode}_${kind === 'widget' ? 'g' : ''}sk_fixture-secret`; env.LAUNCH_APPROVED = 'true';
  }
  env.BETA_MODE = mode === 'live' ? 'false' : 'true';
  const database = new DatabaseSync(':memory:'); database.exec('PRAGMA foreign_keys=ON');
  migrations.forEach(sql => database.exec(sql));
  if (config) database.prepare("INSERT INTO billing_config VALUES ('launch',?,?)").run(JSON.stringify(config), Date.now());
  function prepare(query) {
    let values = [];
    const statement = {
      bind(...parameters) { values = parameters; return statement; },
      async first() { return database.prepare(query).get(...values) || null; },
      async all() { return { results: database.prepare(query).all(...values) }; },
      _run() { const result = database.prepare(query).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      async run() { return statement._run(); },
    };
    return statement;
  }
  const sql = { prepare, async batch(statements) {
    // A D1 batch is atomic and cannot interleave with another request. Keep the
    // fixture synchronous inside its transaction so Promise.all tests reflect it.
    database.exec('BEGIN');
    try { const result = statements.map(statement => statement._run()); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
  env.DB = sql;
  const calls = [];
  let transport = () => { throw new Error('Unexpected provider request'); };
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers };
    calls.push(call);
    assert.match(call.url, /^https:\/\/api\.tosspayments\.com\/v1\/payments\//);
    assert.ok(call.headers.Authorization.startsWith('Basic '));
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    return transport(call);
  };
  const call = (path, body, owner = 'alice', headers) => billing.paymentRequest(jsonRequest('payments/' + path, body, headers), sql, owner, ['payments', ...path.split('/')]);
  const create = async (owner = 'alice', overrides = {}) => {
    const overview = await billing.upgradeOverview(sql, owner);
    const body = { productId: BILLING_PRODUCTS[0].id, requestId: crypto.randomUUID(), consent: { accepted: true, version: overview.terms.version, policyHash: overview.terms.policyHash }, ...overrides };
    return { order: await call('orders', body, owner), body };
  };
  const confirm = (order, key = 'payment:opaque/value=1', owner = 'alice', overrides = {}) => call('confirm', { orderId: order.orderId, paymentKey: key, amount: order.amount, ...overrides }, owner);
  const webhook = (body, headers) => billing.paymentWebhook(jsonRequest('payments/webhook', body, headers), sql);
  const cancel = body => billing.adminCancelPayment(jsonRequest('admin/payments/cancel', body), sql);
  const row = id => database.prepare('SELECT * FROM payments WHERE id=?').get(id);
  return { sql, database, calls, call, create, confirm, webhook, cancel, row,
    setTransport(fn) { transport = fn; },
    close() { database.close(); globalThis.fetch = originalFetch; },
  };
}
function paid(order, paymentKey = 'payment:opaque/value=1', extra = {}) {
  return { orderId: order.orderId, paymentKey, totalAmount: order.amount, balanceAmount: order.amount, currency: 'KRW', status: 'DONE', approvedAt: '2026-11-07T17:30:00+09:00', cancels: null, lastTransactionKey: 'approved:transaction/value', ...extra };
}
function canceled(payment, amounts, statuses = amounts.map(() => 'DONE')) {
  const cancels = amounts.map((amount, index) => ({ transactionKey: 'cancel:transaction/' + (index + 1), cancelAmount: amount, cancelStatus: statuses[index] }));
  const total = cancels.filter(cancel => cancel.cancelStatus === 'DONE').reduce((sum, cancel) => sum + cancel.cancelAmount, 0);
  return { ...payment, cancels, balanceAmount: payment.totalAmount - total,
    status: total === payment.totalAmount ? 'CANCELED' : total > 0 ? 'PARTIAL_CANCELED' : payment.status,
    lastTransactionKey: cancels.at(-1)?.transactionKey || payment.lastTransactionKey };
}
const event = payment => ({ eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId: payment.orderId, paymentKey: payment.paymentKey, status: 'FORGED', totalAmount: 999999999 } });
async function fund(f, owner = 'alice', key) {
  const { order } = await f.create(owner);
  const snapshot = paid(order, key);
  f.setTransport(() => Response.json(snapshot));
  await f.confirm(order, snapshot.paymentKey, owner);
  return { order, snapshot };
}

test('migration is additive, retains existing payment rows, and provides current Drizzle metadata', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrations.slice(0, -1).forEach(sql => db.exec(sql));
    const id = 'prism_' + 'a'.repeat(32);
    db.prepare('INSERT INTO payments (id,user_id,amount,mode,status,created_at) VALUES (?,?,?,?,?,?)').run(id, 'legacy-owner', 10000, 'test', 'pending', 1);
    db.exec(migrations.at(-1));
    const row = db.prepare('SELECT * FROM payments WHERE id=?').get(id);
    assert.equal(row.amount, 10000); assert.equal(row.currency, 'KRW'); assert.equal(row.refunded_amount, 0); assert.equal(row.product_id, null);
    assert.equal(row.candidate_payment_key, null);
    const snapshot = JSON.parse(await readFile(new URL('../drizzle/meta/0006_snapshot.json', import.meta.url), 'utf8'));
    assert.ok(snapshot.tables.payment_refunds); assert.ok(snapshot.tables.scheduled_tasks); assert.ok(snapshot.tables.media_assets);
  } finally { db.close(); }
});

test('public catalog works without keys, does not expose private balances or secrets, and cannot create a charge', async () => {
  const f = fixture({ mode: 'disabled', config: null });
  try {
    const publicData = await billing.upgradeOverview(f.sql);
    assert.equal(publicData.mode, 'disabled'); assert.equal(publicData.checkoutAvailable, false); assert.equal(publicData.signedIn, false);
    assert.equal(publicData.beta, true); assert.equal(publicData.balance, null); assert.equal(publicData.testBalance, null);
    assert.deepEqual(publicData.products.map(product => product.amount), [10000, 30000, 50000]);
    assert.match(publicData.terms.policyHash, /^[a-f0-9]{64}$/);
    assert.equal(publicData.terms.refundPolicy, '');
    assert.doesNotMatch(JSON.stringify(publicData), /secret|clientKey|customerKey/);
    await assert.rejects(() => f.create(), errorIs(503, 'PAYMENTS_DISABLED'));
    assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 0); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('checkout gates mismatched key families/environments and all live launch requirements', async () => {
  const f = fixture();
  try {
    assert.equal(billing.paymentMode(goodConfig), 'test');
    env.TOSS_SECRET_KEY = 'test_sk_fixture'; assert.equal(billing.paymentMode(goodConfig), 'disabled');
    env.TOSS_SECRET_KEY = 'live_gsk_fixture'; assert.equal(billing.paymentMode(goodConfig), 'disabled');
    env.TOSS_CLIENT_KEY = 'live_gck_fixture'; env.PAYMENTS_MODE = 'live';
    assert.equal(billing.paymentMode(goodConfig), 'disabled', 'live cannot sell credits while the service is in free beta');
    env.BETA_MODE = 'false'; delete env.LAUNCH_APPROVED; assert.equal(billing.paymentMode(goodConfig), 'disabled');
    env.LAUNCH_APPROVED = 'true'; assert.equal(billing.paymentMode({ ...goodConfig, refundPolicy: '' }), 'disabled');
    assert.equal(billing.paymentMode(goodConfig), 'live');
    env.TOSS_CLIENT_KEY = 'live_gck_bad\nkey'; assert.equal(billing.paymentMode(goodConfig), 'disabled');
  } finally { f.close(); }
});

test('orders enforce canonical products and consent, snapshot policies, and are atomically idempotent', async () => {
  const f = fixture();
  try {
    const overview = await billing.upgradeOverview(f.sql, 'alice');
    const body = { productId: 'credits-10000', requestId: crypto.randomUUID(), consent: { accepted: true, version: overview.terms.version, policyHash: overview.terms.policyHash } };
    for (const invalid of [{ ...body, amount: 1 }, { ...body, productId: 'invented' }, { ...body, consent: { ...body.consent, accepted: false } }, { ...body, requestId: 'bad' }]) {
      await assert.rejects(() => f.call('orders', invalid), errorIs(400));
    }
    await assert.rejects(() => f.call('orders', { ...body, consent: { ...body.consent, policyHash: 'old' } }), errorIs(409, 'TERMS_CHANGED'));
    const [first, second] = await Promise.all([f.call('orders', body), f.call('orders', { ...body, requestId: body.requestId.toUpperCase() })]);
    assert.equal(first.orderId, second.orderId); assert.equal(first.amount, 10000); assert.equal(first.checkoutKind, 'widget');
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM payments').get().n, 1);
    const stored = f.row(first.orderId);
    assert.equal(stored.terms_hash, overview.terms.policyHash); assert.equal(stored.product_id, body.productId);
    assert.equal(JSON.parse(stored.consent_snapshot).product.amount, 10000); assert.equal(JSON.parse(stored.consent_snapshot).accepted, true);
    assert.ok(stored.consented_at > 0); assert.ok(stored.expires_at > stored.created_at);
    await assert.rejects(() => f.call('orders', { ...body, productId: 'credits-30000' }), errorIs(409, 'ORDER_IDEMPOTENCY_CONFLICT'));
    const bob = await f.call('orders', body, 'bob'); assert.notEqual(bob.orderId, first.orderId); assert.notEqual(bob.customerKey, first.customerKey);
    const changed = { ...goodConfig, validityPolicy: 'A newly approved policy.' };
    f.database.prepare("UPDATE billing_config SET value=? WHERE key='launch'").run(JSON.stringify(changed));
    await assert.rejects(() => f.call('orders', { ...body, requestId: crypto.randomUUID() }), errorIs(409, 'TERMS_CHANGED'));
    assert.equal((await f.call('orders', body)).orderId, first.orderId, 'an existing accepted order retains its own policy snapshot');
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('order count, body size/content type, and exact endpoint shapes are bounded', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => f.call('orders/extra', {}), errorIs(404));
    await assert.rejects(() => f.call('orders', '{malformed'), errorIs(400));
    await assert.rejects(() => f.call('orders', ' '.repeat(8193)), errorIs(413));
    await assert.rejects(() => f.call('orders', {}, 'alice', { 'Content-Type': 'text/plain' }), errorIs(415));
    for (let index = 0; index < 10; index++) await f.create();
    await assert.rejects(() => f.create(), errorIs(429, 'TOO_MANY_PENDING_ORDERS'));
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM payments').get().n, 10);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('confirmation enforces ownership and amount, credits exactly once across concurrent callbacks, and isolates test credits', async () => {
  const f = fixture();
  try {
    const { order } = await f.create(); let authorized = false; const approvedKeys = new Set();
    f.setTransport(call => {
      if (call.method === 'POST') { assert.equal(call.body.amount, 10000); approvedKeys.add(call.headers['Idempotency-Key']); authorized = true; }
      return Response.json(paid(order, undefined, authorized ? {} : { status: 'IN_PROGRESS', approvedAt: null }));
    });
    await assert.rejects(() => f.confirm(order, undefined, 'bob'), errorIs(404));
    await assert.rejects(() => f.confirm(order, undefined, 'alice', { amount: 1 }), errorIs(409));
    await assert.rejects(() => f.confirm(order, '', 'alice'), errorIs(400));
    assert.equal(f.calls.length, 0);
    const results = await Promise.all([f.confirm(order), f.confirm(order)]);
    assert.ok(results.every(result => result.status === 'paid')); assert.equal(approvedKeys.size, 1);
    await f.confirm(order);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='topup'").get().n, 1);
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 10000 * WON); assert.equal(await billing.balance(f.sql, 'alice'), 0);
    await assert.rejects(() => billing.reserve(f.sql, 'alice', 'test-cannot-spend', 1), errorIs(402));
    const status = await billing.paymentStatus(f.sql, 'alice', order.orderId); assert.equal(status.mode, 'test');
    assert.doesNotMatch(JSON.stringify(status), /paymentKey|candidate_payment_key|fixture-secret/);
    await assert.rejects(() => billing.paymentStatus(f.sql, 'bob', order.orderId), errorIs(404));
  } finally { f.close(); }
});

test('a mismatched callback cannot bind or poison another order key, and the correct key remains usable', async () => {
  const f = fixture();
  try {
    const alice = (await f.create()).order, bob = (await f.create('bob')).order;
    f.setTransport(call => Response.json(call.url.endsWith('stolen-key') ? paid(bob, 'stolen-key') : paid(alice, 'correct-key')));
    await assert.rejects(() => f.confirm(alice, 'stolen-key'), errorIs(409, 'PAYMENT_MISMATCH'));
    assert.equal(f.row(alice.orderId).payment_key, null); assert.equal(f.row(alice.orderId).candidate_payment_key, null);
    assert.equal(f.row(bob.orderId).payment_key, null);
    await f.confirm(bob, 'stolen-key', 'bob'); await f.confirm(alice, 'correct-key');
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 10000 * WON);
    assert.equal(await billing.balance(f.sql, 'bob', 'test'), 10000 * WON);
  } finally { f.close(); }
});

test('failed callback idempotency cannot poison a subsequent correct payment key', async () => {
  const f = fixture();
  try {
    const { order } = await f.create(); const cache = new Map();
    f.setTransport(call => {
      if (call.method === 'GET') return Response.json({ code: 'NOT_FOUND_PAYMENT' }, { status: 404 });
      const key = call.headers['Idempotency-Key'];
      if (!cache.has(key)) cache.set(key, call.body.paymentKey === 'wrong-key' ? { status: 400, data: { code: 'INVALID_PAYMENT_KEY' } } : { status: 200, data: paid(order, 'correct-key') });
      const response = cache.get(key); return Response.json(response.data, { status: response.status });
    });
    await assert.rejects(() => f.confirm(order, 'wrong-key'), errorIs(502));
    assert.equal(f.row(order.orderId).candidate_payment_key, null);
    assert.equal((await f.confirm(order, 'correct-key')).status, 'paid'); assert.equal(cache.size, 2);
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 10000 * WON);
  } finally { f.close(); }
});

test('lost approval response and later retry recover the same charge without issuing a replacement', async () => {
  const f = fixture();
  try {
    const { order } = await f.create(); let state = 'before', failRecovery = true, posts = 0;
    f.setTransport(call => {
      if (call.method === 'POST') { posts++; state = 'paid'; throw new TypeError('response lost'); }
      if (state === 'before') return Response.json({ code: 'NOT_FOUND_PAYMENT' }, { status: 404 });
      if (failRecovery) throw new TypeError('temporary outage');
      return Response.json(paid(order));
    });
    await assert.rejects(() => f.confirm(order), errorIs(502));
    assert.equal(f.row(order.orderId).payment_key, null); assert.equal(f.row(order.orderId).candidate_payment_key, 'payment:opaque/value=1');
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 0);
    failRecovery = false;
    const result = await f.call('reconcile', { orderId: order.orderId });
    assert.equal(result.status, 'paid'); assert.equal(posts, 1); assert.equal(f.row(order.orderId).candidate_payment_key, null);
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 10000 * WON);
  } finally { f.close(); }
});

test('widget recovery never uses unsupported orderId lookup; individual-key lookup and kill-switch reconciliation work', async () => {
  const f = fixture();
  try {
    const { order } = await f.create();
    await assert.rejects(() => f.call('reconcile', { orderId: order.orderId }), errorIs(409, 'PAYMENT_KEY_REQUIRED'));
    assert.equal(f.calls.length, 0);
    f.setTransport(() => Response.json(paid(order)));
    env.PAYMENTS_MODE = 'disabled'; await f.confirm(order);
    await assert.rejects(() => f.create(), errorIs(503));
    assert.equal((await f.call('reconcile', { orderId: order.orderId })).status, 'paid');
    env.TOSS_SECRET_KEY = 'live_gsk_fixture';
    const calls = f.calls.length; await assert.rejects(() => f.call('reconcile', { orderId: order.orderId }), errorIs(503)); assert.equal(f.calls.length, calls);
  } finally { f.close(); }
  const direct = fixture({ kind: 'payment' });
  try {
    const { order } = await direct.create(); assert.equal(order.checkoutKind, 'payment');
    direct.setTransport(call => { assert.ok(call.url.endsWith('/orders/' + order.orderId)); return Response.json(paid(order)); });
    assert.equal((await direct.call('reconcile', { orderId: order.orderId })).status, 'paid');
  } finally { direct.close(); }
});

test('provider mismatch, malformed cancellation totals, and missing approval evidence never mint credits', async () => {
  for (const change of [{ currency: 'USD' }, { totalAmount: 9999 }, { balanceAmount: 9999 }, { approvedAt: null },
    { status: 'PARTIAL_CANCELED', balanceAmount: 9000, cancels: [{ transactionKey: 'c', cancelAmount: 2000, cancelStatus: 'DONE' }] }]) {
    const f = fixture();
    try {
      const { order } = await f.create(); f.setTransport(() => Response.json(paid(order, undefined, change)));
      await assert.rejects(() => f.confirm(order), error => error instanceof billing.BillingError);
      assert.equal(await billing.balance(f.sql, 'alice', 'test'), 0); assert.equal(f.database.prepare('SELECT COUNT(*) n FROM wallet_events').get().n, 0);
    } finally { f.close(); }
  }
});

test('credit and payment status are atomic if a database write fails', async () => {
  const f = fixture();
  try {
    const { order } = await f.create(); f.setTransport(() => Response.json(paid(order)));
    f.database.exec("CREATE TRIGGER fail_paid BEFORE UPDATE OF status ON payments WHEN NEW.status='paid' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;");
    await assert.rejects(() => f.confirm(order));
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 0); assert.equal(f.row(order.orderId).status, 'pending');
    f.database.exec('DROP TRIGGER fail_paid'); await f.confirm(order);
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 10000 * WON);
  } finally { f.close(); }
});

test('webhook uses authoritative provider values, recovers a missing browser callback, and never approves', async () => {
  const f = fixture();
  try {
    const { order } = await f.create(); const snapshot = paid(order);
    f.setTransport(call => { assert.equal(call.method, 'GET'); return Response.json(snapshot); });
    await f.webhook(event(snapshot));
    assert.equal(f.row(order.orderId).payment_key, snapshot.paymentKey); assert.equal(f.row(order.orderId).status, 'paid');
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 10000 * WON);
    await f.webhook(event(snapshot)); assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='topup'").get().n, 1);
    const next = (await f.create('bob')).order;
    f.setTransport(call => { assert.equal(call.method, 'GET'); return Response.json(paid(next, 'pending-key', { status: 'IN_PROGRESS', approvedAt: null })); });
    await f.webhook({ eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId: next.orderId, paymentKey: 'pending-key', status: 'DONE', totalAmount: 999999 } });
    assert.equal(f.row(next.orderId).status, 'pending'); assert.equal(await billing.balance(f.sql, 'bob', 'test'), 0);
  } finally { f.close(); }
});

test('cumulative partial and full refunds are idempotent and cannot regress under old snapshots', async () => {
  const f = fixture();
  try {
    const { order, snapshot } = await fund(f);
    for (const [amounts, expected] of [[[3000], 7000], [[3000], 7000], [[3000, 2000], 5000], [[3000], 5000], [[], 5000], [[3000, 2000, 5000], 0]]) {
      const current = canceled(snapshot, amounts); f.setTransport(() => Response.json(current)); await f.webhook(event(current));
      assert.equal(await billing.balance(f.sql, 'alice', 'test'), expected * WON);
    }
    const row = f.row(order.orderId); assert.equal(row.refunded_amount, 10000); assert.equal(row.status, 'refunded');
    const debits = f.database.prepare("SELECT amount FROM wallet_events WHERE kind='refund' ORDER BY created_at,rowid").all();
    assert.deepEqual(debits.map(row => row.amount), [-3000 * WON, -2000 * WON, -5000 * WON]);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM account_flags').get().n, 0, 'test refunds must not freeze the live account');
  } finally { f.close(); }
});

test('first observation of a partial refund credits only the correct net amount atomically', async () => {
  const f = fixture();
  try {
    const { order } = await f.create(); const snapshot = canceled(paid(order), [4000]);
    f.setTransport(() => Response.json(snapshot)); await f.webhook(event(snapshot));
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 6000 * WON);
    assert.equal(f.row(order.orderId).status, 'partially_refunded');
    await f.webhook(event(snapshot)); assert.equal(await billing.balance(f.sql, 'alice', 'test'), 6000 * WON);
  } finally { f.close(); }
});

test('an external refund after credits were spent blocks further spending and preserves unrelated flags', async () => {
  const f = fixture({ mode: 'live' });
  try {
    const { order, snapshot } = await fund(f);
    await billing.reserve(f.sql, 'alice', 'real-usage', 8000 * WON);
    await billing.settle(f.sql, 'alice', 'real-usage', 8000 * WON, 8000 * WON);
    const refunded = canceled(snapshot, [10000]); f.setTransport(() => Response.json(refunded)); await f.webhook(event(refunded));
    assert.equal(await billing.balance(f.sql, 'alice'), -8000 * WON);
    assert.equal(f.database.prepare("SELECT reason FROM account_flags WHERE user_id='alice'").get().reason, 'payment_refund_balance');
    await assert.rejects(() => billing.reserve(f.sql, 'alice', 'blocked-usage', 1), errorIs(402));
    await fund(f, 'alice', 'second-payment-key'); assert.equal(await billing.balance(f.sql, 'alice'), 2000 * WON);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM account_flags WHERE user_id='alice'").get().n, 0);
    f.database.prepare("INSERT INTO account_flags VALUES ('alice','separate-admin-review',?)").run(Date.now());
    f.setTransport(() => Response.json(refunded));
    await f.webhook(event(refunded));
    assert.equal(f.database.prepare("SELECT reason FROM account_flags WHERE user_id='alice'").get().reason, 'separate-admin-review');
    assert.equal(f.row(order.orderId).status, 'refunded');
  } finally { f.close(); }
});

test('unpaid virtual-account cancellations do not mint credits; deposit reversals freeze a credited wallet', async () => {
  const f = fixture({ mode: 'live' });
  try {
    const { order } = await f.create(); const unpaid = paid(order, 'unpaid-key', { status: 'CANCELED', approvedAt: null, balanceAmount: 0, cancels: null });
    f.setTransport(() => Response.json(unpaid)); await f.webhook(event(unpaid));
    assert.equal(f.row(order.orderId).status, 'failed'); assert.equal(f.database.prepare('SELECT COUNT(*) n FROM wallet_events').get().n, 0);
    const funded = await fund(f, 'alice', 'deposit-key');
    const reversed = { ...funded.snapshot, status: 'WAITING_FOR_DEPOSIT', approvedAt: null, secret: 'deposit-private-secret' };
    f.setTransport(() => Response.json(reversed));
    await assert.rejects(() => f.webhook({ orderId: funded.order.orderId, status: 'DONE', secret: 'wrong-secret' }), errorIs(401));
    assert.equal(f.row(funded.order.orderId).status, 'paid');
    await f.webhook({ orderId: funded.order.orderId, status: 'DONE', secret: 'deposit-private-secret' });
    assert.equal(f.row(funded.order.orderId).status, 'review');
    await assert.rejects(() => billing.reserve(f.sql, 'alice', 'reversal-blocked', 1), errorIs(402));
    f.setTransport(() => Response.json(funded.snapshot)); await f.call('reconcile', { orderId: funded.order.orderId });
    assert.equal(f.row(funded.order.orderId).status, 'review', 'an older DONE response must not silently undo the reversal hold');
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM account_flags').get().n, 1);
    await assert.rejects(() => billing.reserve(f.sql, 'alice', 'still-needs-review', 1), errorIs(402));
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='topup'").get().n, 1);
  } finally { f.close(); }
});

test('admin partial/full refunds reserve unused credits, persist idempotency, and release the reservation exactly once', async () => {
  const f = fixture();
  try {
    const { order, snapshot } = await fund(f); let current = snapshot; const cache = new Map(); let posts = 0;
    f.setTransport(call => {
      if (call.method === 'POST') {
        posts++; const key = call.headers['Idempotency-Key'];
        if (!cache.has(key)) { current = canceled(snapshot, [...(current.cancels || []).map(cancel => cancel.cancelAmount), call.body.cancelAmount]); cache.set(key, current); }
        return Response.json(cache.get(key));
      }
      return Response.json(current);
    });
    const body = { orderId: order.orderId, amount: 3000, reason: 'Fixture refund', requestId: crypto.randomUUID() };
    const result = await f.cancel(body); assert.equal(result.status, 'partially_refunded'); assert.equal(result.refundStatus, 'succeeded');
    assert.equal(result.balance, 7000 * WON); assert.equal(result.pendingRefundAmount, 0);
    env.TOSS_SECRET_KEY = 'test_gsk_rotated-after-completion';
    const duplicate = await f.cancel({ ...body, requestId: body.requestId.toUpperCase() }); assert.equal(duplicate.balance, 7000 * WON); assert.equal(posts, 1);
    await assert.rejects(() => f.cancel({ ...body, amount: 4000 }), errorIs(409, 'REFUND_IDEMPOTENCY_CONFLICT'));
    const full = await f.cancel({ ...body, requestId: crypto.randomUUID(), amount: 7000 });
    assert.equal(full.status, 'refunded'); assert.equal(full.balance, 0); assert.equal(posts, 2);
    const totals = f.database.prepare('SELECT kind,SUM(amount) total,COUNT(*) n FROM wallet_events GROUP BY kind').all();
    assert.equal(totals.find(row => row.kind === 'refund_reserve').total, -10000 * WON);
    assert.equal(totals.find(row => row.kind === 'refund_release').total, 10000 * WON);
    assert.equal(totals.find(row => row.kind === 'refund').total, -10000 * WON);
  } finally { f.close(); }
});

test('refund cannot spend unavailable credits and concurrent different requests cannot both cancel the same order', async () => {
  const f = fixture({ mode: 'live' });
  try {
    const { order, snapshot } = await fund(f); let current = snapshot; let release;
    f.setTransport(call => {
      if (call.method === 'POST') return new Promise(resolve => { release = () => { current = canceled(snapshot, [6000]); resolve(Response.json(current)); }; });
      return Response.json(current);
    });
    const first = f.cancel({ orderId: order.orderId, amount: 6000, reason: 'First', requestId: crypto.randomUUID() });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal(await billing.balance(f.sql, 'alice'), 4000 * WON);
    await assert.rejects(() => billing.reserve(f.sql, 'alice', 'cannot-spend-refund-reserve', 5000 * WON), errorIs(402));
    await assert.rejects(() => f.cancel({ orderId: order.orderId, amount: 3000, reason: 'Second', requestId: crypto.randomUUID() }), errorIs(409, 'REFUND_NOT_AVAILABLE'));
    release(); await first;
    assert.equal(await billing.balance(f.sql, 'alice'), 4000 * WON);
    await billing.reserve(f.sql, 'alice', 'remaining-usage', 3000 * WON);
    await assert.rejects(() => f.cancel({ orderId: order.orderId, amount: 2000, reason: 'Too much', requestId: crypto.randomUUID() }), errorIs(409, 'REFUND_NOT_AVAILABLE'));
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  } finally { f.close(); }
});

test('lost refund response retains a durable hold; the identical retry cannot refund or debit twice', async () => {
  const f = fixture();
  try {
    const { order, snapshot } = await fund(f); let current = snapshot; let posts = 0; const keys = [];
    f.setTransport(call => {
      if (call.method === 'POST') {
        keys.push(call.headers['Idempotency-Key']); posts++;
        if (posts === 1) { current = canceled(snapshot, [3000]); throw new TypeError('response lost'); }
      }
      return Response.json(current);
    });
    const body = { orderId: order.orderId, amount: 3000, reason: 'Lost response fixture', requestId: crypto.randomUUID() };
    await assert.rejects(() => f.cancel(body), errorIs(502));
    let status = await billing.paymentStatus(f.sql, 'alice', order.orderId);
    assert.equal(status.balance, 4000 * WON); assert.equal(status.pendingRefundAmount, 3000);
    await assert.rejects(() => f.cancel({ ...body, requestId: crypto.randomUUID() }), errorIs(409));
    const done = await f.cancel(body); assert.equal(done.refundStatus, 'succeeded'); assert.equal(done.balance, 7000 * WON); assert.equal(done.pendingRefundAmount, 0);
    assert.equal(new Set(keys).size, 1); assert.equal(posts, 2);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='refund'").get().n, 1);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='refund_release'").get().n, 1);
  } finally { f.close(); }
});

test('definitive refund rejection releases a hold only after a verified provider requery', async () => {
  const f = fixture();
  try {
    const { order, snapshot } = await fund(f); let posts = 0;
    f.setTransport(call => { if (call.method === 'POST') { posts++; return Response.json({ code: 'NOT_CANCELABLE_PAYMENT' }, { status: 400 }); } return Response.json(snapshot); });
    const body = { orderId: order.orderId, amount: 3000, reason: 'Rejected refund fixture', requestId: crypto.randomUUID() };
    await assert.rejects(() => f.cancel(body), errorIs(502));
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 10000 * WON);
    const row = f.database.prepare('SELECT * FROM payment_refunds WHERE request_id=?').get(body.requestId); assert.equal(row.status, 'failed');
    const duplicate = await f.cancel(body); assert.equal(duplicate.refundStatus, 'failed'); assert.equal(posts, 1);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='refund'").get().n, 0);
  } finally { f.close(); }
});

test('asynchronous cancellation resolves a recorded transaction from a verified cancel webhook', async () => {
  const f = fixture();
  try {
    const { order, snapshot } = await fund(f); let current = snapshot;
    f.setTransport(call => { if (call.method === 'POST') current = canceled(snapshot, [3000], ['IN_PROGRESS']); return Response.json(current); });
    const body = { orderId: order.orderId, amount: 3000, reason: 'Async fixture', requestId: crypto.randomUUID() };
    const pending = await f.cancel(body); assert.equal(pending.refundStatus, 'pending'); assert.equal(pending.balance, 7000 * WON);
    current = canceled(snapshot, [3000]);
    await f.webhook({ eventType: 'CANCEL_STATUS_CHANGED', data: { transactionKey: current.lastTransactionKey, cancelAmount: 99999, cancelStatus: 'FAILED' } });
    const complete = await billing.paymentStatus(f.sql, 'alice', order.orderId); assert.equal(complete.balance, 7000 * WON); assert.equal(complete.pendingRefundAmount, 0);
    assert.equal(f.database.prepare('SELECT status FROM payment_refunds WHERE request_id=?').get(body.requestId).status, 'succeeded');
  } finally { f.close(); }
});

test('uncertain cancellation is not blindly retried after the provider idempotency retention window', async () => {
  const f = fixture();
  try {
    const { order, snapshot } = await fund(f); let submitted = false;
    f.setTransport(call => { if (call.method === 'POST') { submitted = true; throw new TypeError('timeout'); } if (submitted) throw new TypeError('offline'); return Response.json(snapshot); });
    const body = { orderId: order.orderId, amount: 3000, reason: 'Old uncertainty fixture', requestId: crypto.randomUUID() };
    await assert.rejects(() => f.cancel(body), errorIs(502));
    f.database.prepare('UPDATE payment_refunds SET created_at=? WHERE request_id=?').run(Date.now() - 15 * 86400000, body.requestId);
    const calls = f.calls.length;
    await assert.rejects(() => f.cancel(body), errorIs(409, 'REFUND_REVIEW_REQUIRED'));
    assert.equal(f.calls.length, calls); assert.equal(await billing.balance(f.sql, 'alice', 'test'), 7000 * WON);
    assert.equal(f.database.prepare('SELECT status FROM payment_refunds WHERE request_id=?').get(body.requestId).status, 'review');
  } finally { f.close(); }
});

async function webhookHeaders(payload, securityKey, time = '2026-11-07T17:30:00+09:00') {
  const bytes = Buffer.from(securityKey, 'hex');
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload + ':' + time))).toString('base64');
  return { 'tosspayments-webhook-transmission-time': time, 'tosspayments-webhook-signature': 'v2:ignored,v1:' + Buffer.alloc(32).toString('base64') + ',v1:' + signature };
}

test('optional webhook HMAC verifies exact raw UTF-8 and supports rotated signatures; replay remains idempotent', async () => {
  const f = fixture();
  try {
    const { order } = await f.create(); const snapshot = paid(order); f.setTransport(() => Response.json(snapshot));
    env.TOSS_WEBHOOK_SECURITY_KEY = 'a1'.repeat(32);
    const payload = JSON.stringify({ ...event(snapshot), ignoredText: '한글 body' }, null, 2) + '\n';
    const headers = await webhookHeaders(payload, env.TOSS_WEBHOOK_SECURITY_KEY);
    await assert.rejects(() => f.webhook(payload), errorIs(401));
    await assert.rejects(() => f.webhook(payload + ' ', headers), errorIs(401));
    assert.equal(f.calls.length, 0);
    await f.webhook(payload, headers); await f.webhook(payload, headers);
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 10000 * WON);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='topup'").get().n, 1);
    env.TOSS_WEBHOOK_SECURITY_KEY = 'invalid-hex'; await assert.rejects(() => f.webhook(payload, headers), errorIs(503));
  } finally { f.close(); }
});

test('unknown or oversized webhooks cannot trigger provider requests; known-order requery is rate bounded', async () => {
  const f = fixture();
  try {
    assert.equal((await f.webhook({ eventType: 'BILLING_DELETED', data: {} })).ignored, true);
    assert.equal((await f.webhook({ eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: 'unknown' } })).ignored, true);
    await assert.rejects(() => f.webhook(' '.repeat(65537)), errorIs(413));
    await assert.rejects(() => f.webhook('{bad'), errorIs(400)); assert.equal(f.calls.length, 0);
    const { order } = await f.create(); const snapshot = paid(order); f.setTransport(() => Response.json(snapshot));
    for (let index = 0; index < 30; index++) await f.webhook(event(snapshot));
    await assert.rejects(() => f.webhook(event(snapshot)), errorIs(429));
    assert.equal(f.calls.length, 30); assert.equal(await billing.balance(f.sql, 'alice', 'test'), 10000 * WON);
  } finally { f.close(); }
});

test('a consent captured in test mode cannot silently create a live purchase after configuration changes', async () => {
  const f = fixture();
  try {
    const overview = await billing.upgradeOverview(f.sql, 'alice');
    const old = { productId: 'credits-10000', requestId: crypto.randomUUID(), consent: { accepted: true, version: overview.terms.version, policyHash: overview.terms.policyHash } };
    env.PAYMENTS_MODE = 'live'; env.TOSS_CLIENT_KEY = 'live_gck_fixture'; env.TOSS_SECRET_KEY = 'live_gsk_fixture'; env.BETA_MODE = 'false';
    await assert.rejects(() => f.call('orders', old), errorIs(409, 'TERMS_CHANGED'));
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM payments').get().n, 0);
    const current = await billing.upgradeOverview(f.sql, 'alice'); assert.notEqual(current.terms.policyHash, old.consent.policyHash);
    const order = await f.call('orders', { ...old, consent: { ...old.consent, policyHash: current.terms.policyHash } });
    assert.equal(order.mode, 'live'); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('in-flight idempotency conflicts retain a refund hold until the same request resolves', async () => {
  for (const [status, code] of [[409, 'IDEMPOTENT_REQUEST_PROCESSING'], [400, 'IDEMPOTENT_REQUEST_PROCESSING'], [408, 'REQUEST_TIMEOUT']]) {
    const f = fixture();
    try {
      const { order, snapshot } = await fund(f); let current = snapshot; let posts = 0; const idempotencyKeys = [];
      f.setTransport(call => {
        if (call.method === 'POST') {
          idempotencyKeys.push(call.headers['Idempotency-Key']); posts++;
          if (posts === 1) return Response.json({ code }, { status });
          current = canceled(snapshot, [3000]);
        }
        return Response.json(current);
      });
      const body = { orderId: order.orderId, amount: 3000, reason: 'In-flight refund fixture', requestId: crypto.randomUUID() };
      await assert.rejects(() => f.cancel(body), errorIs(502));
      const unresolved = f.database.prepare('SELECT status FROM payment_refunds WHERE request_id=?').get(body.requestId);
      assert.equal(unresolved.status, 'pending', `${status} ${code} must not mark the running cancellation failed`);
      assert.equal(await billing.balance(f.sql, 'alice', 'test'), 7000 * WON);
      assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='refund_release'").get().n, 0);
      assert.equal((await billing.paymentStatus(f.sql, 'alice', order.orderId)).pendingRefundAmount, 3000);
      const resolved = await f.cancel(body);
      assert.equal(resolved.refundStatus, 'succeeded'); assert.equal(resolved.balance, 7000 * WON);
      assert.equal(resolved.pendingRefundAmount, 0); assert.equal(posts, 2); assert.equal(new Set(idempotencyKeys).size, 1);
      assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='refund'").get().n, 1);
      assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='refund_release'").get().n, 1);
    } finally { f.close(); }
  }
});

test('rotating the API secret cannot resubmit an uncertain refund in a new idempotency namespace', async () => {
  const f = fixture();
  try {
    const { order, snapshot } = await fund(f); let current = snapshot; let posts = 0;
    f.setTransport(call => {
      if (call.method === 'POST') { posts++; current = canceled(snapshot, [3000]); throw new TypeError('refund response lost'); }
      return Response.json(current);
    });
    const originalSecret = env.TOSS_SECRET_KEY;
    const body = { orderId: order.orderId, amount: 3000, reason: 'Rotated secret fixture', requestId: crypto.randomUUID() };
    await assert.rejects(() => f.cancel(body), errorIs(502));
    const before = f.database.prepare('SELECT * FROM payment_refunds WHERE request_id=?').get(body.requestId);
    assert.equal(before.status, 'pending'); assert.match(before.idempotency_key, /^cancel:v1:[a-f0-9-]{36}:[a-f0-9]{64}$/);
    assert.equal(before.idempotency_key.includes(originalSecret), false);
    const heldBalance = await billing.balance(f.sql, 'alice', 'test'); assert.equal(heldBalance, 4000 * WON);
    env.TOSS_SECRET_KEY = 'test_gsk_rotated-within-same-mode';
    const calls = f.calls.length;
    await assert.rejects(() => f.cancel(body), errorIs(409, 'REFUND_KEY_CHANGED'));
    assert.equal(f.calls.length, calls, 'secret rotation must not trigger another provider request for the uncertain cancellation');
    assert.equal(posts, 1); assert.equal(await billing.balance(f.sql, 'alice', 'test'), heldBalance);
    const after = f.database.prepare('SELECT * FROM payment_refunds WHERE request_id=?').get(body.requestId);
    assert.equal(after.status, 'review'); assert.equal(after.last_error, 'REFUND_KEY_CHANGED');
    assert.equal(after.idempotency_key, before.idempotency_key);
    assert.equal((await billing.paymentStatus(f.sql, 'alice', order.orderId)).pendingRefundAmount, 3000);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='refund_release'").get().n, 0);
    const publicData = await billing.billingOverview(f.sql, 'alice');
    assert.equal(JSON.stringify(publicData).includes(before.idempotency_key), false);
    assert.equal(JSON.stringify(publicData).includes(originalSecret), false);
  } finally { f.close(); }
});
