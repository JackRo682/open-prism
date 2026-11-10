import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import ts from 'typescript';

const directory = new URL('../.sites-runtime/billing-security-tests/', import.meta.url);
await mkdir(directory, { recursive: true });
const env = {};
globalThis.__prismBillingSecurityEnv = env;
await writeFile(new URL('context.mjs', directory), 'export const env = globalThis.__prismBillingSecurityEnv;');
for (const name of ['models', 'billing-contract', 'billing']) {
  let source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8');
  source = source.replaceAll("'cloudflare:workers'", "'./context.mjs'");
  for (const imported of ['models', 'billing-contract']) source = source.replaceAll(`'./${imported}'`, `'./${imported}.mjs'`);
  await writeFile(new URL(`${name}.mjs`, directory), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}
const billing = await import(new URL('billing.mjs', directory).href);
const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url)))
  .filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')));
const originalFetch = globalThis.fetch;
const WON = 1_000_000;
const encoder = new TextEncoder();
const providerError = code => error => {
  assert.ok(error instanceof billing.BillingError);
  assert.equal(error.status, 502);
  assert.equal(error.code, 'PAYMENT_PROVIDER_UNAVAILABLE');
  assert.equal(error.providerCode, code);
  assert.equal(error.definitive, false);
  assert.doesNotMatch(error.message, /fixture-secret|private-provider-error/);
  return true;
};
const request = (path, body) => new Request('https://prism.test/api/' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://prism.test' }, body: JSON.stringify(body),
});
function fixture() {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, { PAYMENTS_MODE: 'test', TOSS_CLIENT_KEY: 'test_gck_fixture-client', TOSS_SECRET_KEY: 'test_gsk_fixture-secret', BETA_MODE: 'true' });
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  for (const migration of migrations) database.exec(migration);
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
    database.exec('BEGIN');
    try { const result = statements.map(statement => statement._run()); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
  env.DB = sql;
  const calls = [];
  let transport = () => { throw new Error('Unexpected provider request'); };
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers };
    assert.match(call.url, /^https:\/\/api\.tosspayments\.com\/v1\/payments\//);
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    calls.push(call);
    return transport(call);
  };
  const call = (path, body) => billing.paymentRequest(request('payments/' + path, body), sql, 'alice', ['payments', path]);
  const create = async () => {
    const overview = await billing.upgradeOverview(sql, 'alice');
    return call('orders', { productId: 'credits-10000', requestId: crypto.randomUUID(), consent: {
      accepted: true, version: overview.terms.version, policyHash: overview.terms.policyHash,
    } });
  };
  const confirm = order => call('confirm', { orderId: order.orderId, paymentKey: 'fixture-payment-key', amount: order.amount });
  return { sql, database, calls, create, confirm,
    cancel: body => billing.adminCancelPayment(request('admin/payments/cancel', body), sql),
    setTransport(fn) { transport = fn; },
    close() { database.close(); globalThis.fetch = originalFetch; },
  };
}
function paid(order, extra = {}) {
  return { orderId: order.orderId, paymentKey: 'fixture-payment-key', totalAmount: order.amount, balanceAmount: order.amount,
    currency: 'KRW', status: 'DONE', approvedAt: '2026-11-07T17:30:00+09:00', cancels: null, ...extra };
}

test('bounded provider parsing still accepts split UTF-8 payment responses and credits once', async () => {
  const f = fixture();
  try {
    const order = await f.create();
    f.setTransport(() => {
      const bytes = encoder.encode(JSON.stringify(paid(order, { orderName: 'Prism 크레딧', note: '가'.repeat(1024) })));
      // One-byte chunks deliberately split multibyte characters at every boundary.
      let offset = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(offset, ++offset));
      } }), { headers: { 'Content-Type': 'application/json' } });
    });
    assert.equal((await f.confirm(order)).status, 'paid');
    assert.equal((await f.confirm(order)).status, 'paid');
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 10000 * WON);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='topup'").get().n, 1);
  } finally { f.close(); }
});

test('oversized declared provider bodies are canceled before reading, without waiting for upstream cleanup', { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    const order = await f.create(); let reads = 0, canceled = false;
    f.setTransport(() => new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(encoder.encode('private-provider-error')); },
      cancel() { canceled = true; return new Promise(() => {}); },
    }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024) } }));
    await assert.rejects(() => f.confirm(order), providerError('RESPONSE_TOO_LARGE'));
    assert.equal(reads, 0); assert.equal(canceled, true); assert.equal(f.calls.length, 1);
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 0);
    const row = f.database.prepare('SELECT status,candidate_payment_key,last_error FROM payments WHERE id=?').get(order.orderId);
    assert.equal(row.status, 'pending'); assert.equal(row.candidate_payment_key, 'fixture-payment-key');
    assert.equal(row.last_error, 'RESPONSE_TOO_LARGE');
  } finally { f.close(); }
});

test('provider redirects are rejected before body parsing and retain the pending operation without crediting funds', async () => {
  const f = fixture();
  try {
    const order = await f.create(); let reads = 0, canceled = false;
    f.setTransport(() => new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(encoder.encode('private-provider-error fixture-secret')); },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 }), { status: 307, headers: { Location: 'https://foreign.test/payments' } }));
    await assert.rejects(() => f.confirm(order), providerError('UNEXPECTED_REDIRECT'));
    assert.equal(reads, 0); assert.equal(canceled, true); assert.equal(f.calls.length, 1);
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 0);
    const row = f.database.prepare('SELECT status,last_error FROM payments WHERE id=?').get(order.orderId);
    assert.equal(row.status, 'pending'); assert.equal(row.last_error, 'UNEXPECTED_REDIRECT');
  } finally { f.close(); }
});

test('actual streamed provider bytes are bounded when Content-Length is absent or understated', async () => {
  for (const contentLength of [null, '1']) {
    const f = fixture();
    try {
      const order = await f.create(); let reads = 0, canceled = false;
      const chunk = encoder.encode('가'.repeat(128 * 1024));
      f.setTransport(() => new Response(new ReadableStream({
        pull(controller) { reads++; controller.enqueue(chunk); },
        cancel() { canceled = true; },
      }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json', ...(contentLength ? { 'Content-Length': contentLength } : {}) } }));
      await assert.rejects(() => f.confirm(order), providerError('RESPONSE_TOO_LARGE'));
      assert.equal(reads, 3, 'the byte limit is enforced before accepting 1 MiB of multibyte text');
      assert.equal(canceled, true);
      assert.equal(await billing.balance(f.sql, 'alice', 'test'), 0);
      assert.equal(f.database.prepare('SELECT COUNT(*) n FROM wallet_events').get().n, 0);
    } finally { f.close(); }
  }
});

test('malformed UTF-8 cannot be silently repaired into an accepted payment snapshot', async () => {
  const f = fixture();
  try {
    const order = await f.create();
    const prefix = encoder.encode(JSON.stringify(paid(order)).slice(0, -1) + ',"note":"');
    const suffix = encoder.encode('"}');
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
    bytes.set(prefix); bytes[prefix.length] = 0xff; bytes.set(suffix, prefix.length + 1);
    f.setTransport(() => new Response(bytes, { headers: { 'Content-Type': 'application/json' } }));
    await assert.rejects(() => f.confirm(order), providerError('INVALID_RESPONSE'));
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 0);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM wallet_events').get().n, 0);
  } finally { f.close(); }
});

test('unreadable oversized refund errors preserve the hold and the same retry remains idempotent', async () => {
  const f = fixture();
  try {
    const order = await f.create(), snapshot = paid(order);
    f.setTransport(() => Response.json(snapshot));
    await f.confirm(order);
    const body = { orderId: order.orderId, amount: 3000, reason: 'Fixture refund', requestId: crypto.randomUUID() };
    const idempotencyKeys = [];
    f.setTransport(call => {
      if (call.method === 'GET') return Response.json(snapshot);
      idempotencyKeys.push(call.headers['Idempotency-Key']);
      return Response.json({ code: 'NOT_CANCELABLE_PAYMENT', message: 'private-provider-error: fixture-secret' }, {
        status: 400, headers: { 'Content-Length': String(2 * 1024 * 1024) },
      });
    });
    await assert.rejects(() => f.cancel(body), providerError('RESPONSE_TOO_LARGE'));
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 7000 * WON);
    assert.equal(f.database.prepare('SELECT status FROM payment_refunds WHERE request_id=?').get(body.requestId).status, 'pending');
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='refund_release'").get().n, 0);
    const canceled = { ...snapshot, balanceAmount: 7000, status: 'PARTIAL_CANCELED',
      cancels: [{ transactionKey: 'fixture-cancel-key', cancelAmount: 3000, cancelStatus: 'DONE' }], lastTransactionKey: 'fixture-cancel-key' };
    f.setTransport(call => { if (call.method === 'POST') idempotencyKeys.push(call.headers['Idempotency-Key']); return Response.json(canceled); });
    assert.equal((await f.cancel(body)).refundStatus, 'succeeded');
    assert.equal((await f.cancel(body)).refundStatus, 'succeeded');
    assert.equal(new Set(idempotencyKeys).size, 1); assert.equal(idempotencyKeys.length, 2);
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 7000 * WON);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='refund'").get().n, 1);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='refund_release'").get().n, 1);
  } finally { f.close(); }
});

test('wallet history cannot be updated or deleted, including after a payment retry', async () => {
  const f = fixture();
  try {
    const order = await f.create();
    f.setTransport(() => Response.json(paid(order)));
    await f.confirm(order);
    const before = f.database.prepare('SELECT * FROM wallet_events').all();
    for (const query of [
      'UPDATE wallet_events SET amount=amount+1',
      "UPDATE wallet_events SET user_id='other-account'",
      'DELETE FROM wallet_events',
    ]) assert.throws(() => f.database.exec(query), /WALLET_LEDGER_IMMUTABLE/);
    assert.deepEqual(f.database.prepare('SELECT * FROM wallet_events').all(), before);
    assert.equal((await f.confirm(order)).status, 'paid');
    assert.equal(await billing.balance(f.sql, 'alice', 'test'), 10000 * WON);
    assert.deepEqual(f.database.prepare('SELECT * FROM wallet_events').all(), before);
  } finally { f.close(); }
});

test('database rejects non-integral ledger amounts, wrong signs, and unsafe aggregate balances', async () => {
  const f = fixture();
  try {
    const insert = (amount, kind = 'topup', mode = 'live', reference = crypto.randomUUID()) =>
      f.database.prepare('INSERT INTO wallet_events (id,user_id,mode,kind,amount,reference,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), 'alice', mode, kind, amount, reference, Date.now());
    for (const [amount,kind,mode] of [
      [1.5,'topup','live'], [Number.MAX_SAFE_INTEGER+1,'topup','live'], [-Number.MAX_SAFE_INTEGER-1,'refund','live'],
      ['not-money','topup','live'], [1,'topup','unknown'], [-1,'topup','live'], [0,'topup','live'],
      [1,'reserve','live'], [1,'refund','live'], [1,'refund_reserve','live'], [-1,'settle','live'], [-1,'refund_release','live'],
    ]) assert.throws(() => insert(amount,kind,mode), /WALLET_(?:AMOUNT|BALANCE)_INVALID/);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM wallet_events').get().n, 0);
    insert(Number.MAX_SAFE_INTEGER, 'topup', 'live', 'safe-limit');
    assert.throws(() => insert(1), /WALLET_BALANCE_INVALID/);
    assert.equal(await billing.balance(f.sql, 'alice'), Number.MAX_SAFE_INTEGER);
    // A legitimate duplicate callback adds no amount even at the integer limit.
    f.database.prepare("INSERT INTO wallet_events VALUES (?,'alice','live','topup',?,'safe-limit',?) ON CONFLICT(reference) DO NOTHING")
      .run(crypto.randomUUID(), Number.MAX_SAFE_INTEGER, Date.now());
    assert.equal(await billing.balance(f.sql, 'alice'), Number.MAX_SAFE_INTEGER);
    insert(-Number.MAX_SAFE_INTEGER, 'refund');
    insert(-Number.MAX_SAFE_INTEGER, 'refund');
    assert.throws(() => insert(-1,'refund'), /WALLET_BALANCE_INVALID/);
    assert.equal(await billing.balance(f.sql, 'alice'), -Number.MAX_SAFE_INTEGER);
  } finally { f.close(); }
});

test('settlement cannot turn a test debit or another ledger kind into live credit', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    f.database.prepare("INSERT INTO wallet_events VALUES ('test-debit','alice','test','reserve',-500,'reserve:test-debit',?)").run(now);
    await billing.settle(f.sql,'alice','test-debit',500,0);
    f.database.prepare("INSERT INTO wallet_events VALUES ('wrong-kind','alice','live','refund',-500,'reserve:wrong-kind',?)").run(now);
    await billing.settle(f.sql,'alice','wrong-kind',500,0);
    f.database.prepare("INSERT INTO wallet_events VALUES ('other-owner','bob','live','reserve',-500,'reserve:other-owner',?)").run(now);
    await billing.settle(f.sql,'alice','other-owner',500,0);
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM wallet_events WHERE kind='settle'").get().n,0);
    assert.equal(await billing.balance(f.sql,'alice'),-500);
    assert.equal(await billing.balance(f.sql,'alice','test'),-500);
  } finally { f.close(); }
});

test('malformed reservation and rate arithmetic fails before a ledger write', async () => {
  const f = fixture();
  try {
    for (const reserved of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'500']) {
      await assert.rejects(() => billing.settle(f.sql,'alice','malformed',reserved,0), error => {
        assert.equal(error.code,'USAGE_RECONCILIATION_REQUIRED'); return true;
      });
    }
    for (const rate of [null,{}, {input:0,output:1}, {input:-1,output:1}, {input:1.5,output:2}, {input:1,output:Infinity}, {input:1_000_001,output:1}]) {
      assert.throws(() => billing.cost(rate,1,1), error => error.code==='USAGE_RECONCILIATION_REQUIRED');
    }
    assert.equal(billing.cost({input:1,output:2},3,4),11);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM wallet_events').get().n,0);
  } finally { f.close(); }
});

test('missing or unknown cancellation status cannot be assumed to be a completed refund', async () => {
  for (const cancelStatus of [undefined,null,'PENDING',false]) {
    const f = fixture();
    try {
      const order=await f.create();
      f.setTransport(() => Response.json(paid(order,{status:'PARTIAL_CANCELED',balanceAmount:7000,
        cancels:[{transactionKey:'cancel-status-fixture',cancelAmount:3000,...(cancelStatus===undefined?{}:{cancelStatus})}]})));
      await assert.rejects(() => f.confirm(order), error => error.code==='INVALID_PROVIDER_REFUND');
      assert.equal(await billing.balance(f.sql,'alice','test'),0);
      assert.equal(f.database.prepare('SELECT COUNT(*) n FROM wallet_events').get().n,0);
    } finally { f.close(); }
  }
});
