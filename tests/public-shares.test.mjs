import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Real handlers and SQLite migrations; only framework/identity boundaries are
// replaced. No model calls, real user records, or public links are created.
const runtime = new URL('../.sites-runtime/public-share-tests/', import.meta.url);
await mkdir(runtime, { recursive: true });
let sqlite, user;
const env = {};
globalThis.__publicShareTest = { env, getChatGPTUser: async () => user };
await writeFile(new URL('context.mjs', runtime), `
export const {env,getChatGPTUser}=globalThis.__publicShareTest;
export const notFound=()=>{throw new Error('NOT_FOUND');};
export const chatGPTSignInPath=path=>'/signin-with-chatgpt?return_to='+encodeURIComponent(path);
`);
const modules = ['models', 'provider', 'chat-title', 'billing-contract', 'billing', 'beta', 'workspace-settings', 'workspace-tools', 'workspace-bootstrap', 'workspace-startup', 'conversation-actions', 'chat-generation', 'regenerate-style', 'media-provider', 'media-workspace', 'browser-workspace', 'scheduled-tasks', 'schedule-time', 'work-artifacts', 'guest-chat', 'guest-import', 'request-security', 'public-shares', 'upload-security', 'api-resource-guards', 'request-lease', 'schedule-runner', 'security-monitoring', 'account-deletion', 'upload-validation', 'image-validation'];
for (const [source, target] of [...modules.map(name => ['lib/' + name + '.ts', name + '.mjs']), ['app/api/[...path]/route.ts', 'route.mjs'], ['app/public-page.tsx', 'public-page.mjs']]) {
  let code = (await readFile(new URL('../' + source, import.meta.url), 'utf8'))
    .replaceAll("'cloudflare:workers'", "'./context.mjs'")
    .replaceAll("'../../chatgpt-auth'", "'./context.mjs'")
    .replaceAll("'next/navigation'", "'./context.mjs'")
    .replaceAll("'./chatgpt-auth'", "'./context.mjs'");
  for (const name of modules) code = code.replaceAll("'../../../lib/" + name + "'", "'./" + name + ".mjs'")
    .replaceAll("'../lib/" + name + "'", "'./" + name + ".mjs'").replaceAll("'./" + name + "'", "'./" + name + ".mjs'");
  await writeFile(new URL(target, runtime), ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText);
}
const route = await import(new URL('route.mjs', runtime));
const { readPublicShare, publicShareMessages } = await import(new URL('public-shares.mjs', runtime));
const { PublicSharePage } = await import(new URL('public-page.mjs', runtime));
const migrationNames = (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
const migrations = await Promise.all(migrationNames.map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')));

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const migration of migrations) sqlite.exec(migration);
  user = { userId: 'alice', email: 'alice@example.test' };
  env.DB = {
    prepare(query) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async first() { return sqlite.prepare(query).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(query).all(...values) }; },
        _run() { return { success: true, meta: { changes: Number(sqlite.prepare(query).run(...values).changes) } }; },
        async run() { return this._run(); },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results=statements.map(statement=>statement._run()); sqlite.exec('COMMIT'); return results; }
      catch(error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
});
afterEach(() => sqlite.close());

function call(path, method = 'GET', body, headers = {}) {
  return route[method](new Request('https://prism.test/api/' + path, {
    method, headers: { origin: 'https://prism.test', ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
}
function seed(id = 'alice-chat', owner = 'alice', title = 'Private conversation', content = 'Review this prompt.') {
  const now = Date.now();
  sqlite.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, owner, title, 'gpt-6.1-sol', now, now);
  sqlite.prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)').run(id + '-user', id, 'user', content, now);
  return id;
}
async function review(id) {
  const response = await call('shares/preview?conversationId=' + encodeURIComponent(id));
  assert.equal(response.status, 200);
  return response.json();
}
async function create(id, extra = {}) {
  const reviewed = await review(id);
  return call('shares', 'POST', { conversationId: id, previewHash: reviewed.previewHash, privacyConfirmed: true, ...extra });
}

test('migration preserves old snapshots and explicitly leaves legacy links without expiration', async () => {
  const legacy = new DatabaseSync(':memory:');
  try {
    const expiryMigration = migrationNames.indexOf('0009_public_share_expiry.sql');
    assert.ok(expiryMigration >= 0);
    for (const migration of migrations.slice(0, expiryMigration)) legacy.exec(migration);
    legacy.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('old-chat', 'alice', 'Old title', 'gpt-6.1-sol', 1, 1);
    legacy.prepare('INSERT INTO public_shares (id,user_id,conversation_id,token,title,snapshot,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('old-share', 'alice', 'old-chat', 'a'.repeat(64), 'Old title', '[{"role":"user","content":"Old snapshot"}]', 1);
    legacy.exec(migrations[expiryMigration]);
    const row = legacy.prepare('SELECT * FROM public_shares WHERE id=?').get('old-share');
    assert.equal(row.expires_at, null); assert.equal(row.token, 'a'.repeat(64)); assert.equal(row.snapshot, '[{"role":"user","content":"Old snapshot"}]');
    const metadata = JSON.parse(await readFile(new URL('../drizzle/meta/0009_snapshot.json', import.meta.url), 'utf8'));
    assert.equal(metadata.tables.public_shares.columns.expires_at.notNull, false);
  } finally { legacy.close(); }
});

test('public sharing requires owner authentication, a preview, and explicit privacy confirmation', async () => {
  const id = seed();
  const reviewed = await review(id);
  for (const consent of [undefined, false, 'true', 1]) {
    const response = await call('shares', 'POST', { conversationId: id, previewHash: reviewed.previewHash, privacyConfirmed: consent });
    assert.equal(response.status, 400); assert.equal((await response.json()).code, 'SHARE_CONFIRMATION_REQUIRED');
  }
  assert.equal((await call('shares', 'POST', { conversationId: id, privacyConfirmed: true })).status, 409);
  user = null;
  assert.equal((await call('shares/preview?conversationId=' + id)).status, 401);
  assert.equal((await call('shares', 'POST', { conversationId: id, privacyConfirmed: true, previewHash: reviewed.previewHash })).status, 401);
  user = { userId: 'bob', email: 'bob@example.test' };
  assert.equal((await call('shares/preview?conversationId=' + id)).status, 404);
  assert.equal((await call('shares', 'POST', { conversationId: id, privacyConfirmed: true, previewHash: reviewed.previewHash })).status, 404);
  user = { userId: 'alice', email: 'alice@example.test' };
  assert.equal((await call('shares', 'POST', { conversationId: id, privacyConfirmed: true, previewHash: reviewed.previewHash }, { origin: 'https://attacker.test' })).status, 403);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM public_shares').get().n, 0);
});

test('new links default to seven days and reject unbounded or ambiguous expiry input', async () => {
  const id = seed(), before = Date.now();
  const response = await create(id); assert.equal(response.status, 201);
  const share = await response.json();
  assert.ok(share.expires_at >= before + 7 * 86_400_000);
  assert.ok(share.expires_at <= Date.now() + 7 * 86_400_000);
  assert.match(share.token, /^[a-f0-9]{64}$/);
  assert.equal(share.url, 'https://prism.test/share/' + share.token);
  for (const days of [0, -1, 2, 365, '7', 'never', true, {}, []]) assert.equal((await create(id, { expiresInDays: days })).status, 400);
  for (const days of [1, 7, 30, null]) {
    const created = await create(id, { expiresInDays: days }); assert.equal(created.status, 201);
    assert.equal((await created.json()).expires_at === null, days === null);
  }
});

test('preview and stored snapshot exclude file contents, hidden roles and metadata', async () => {
  const secret = 'PRIVATE FILE BODY';
  const id = seed('alice-chat', 'alice', 'Review me', 'Prompt\n\n<attached_document name="secret.txt">' + secret + '</attached_document>\n' + secret);
  sqlite.prepare('INSERT INTO messages (id,conversation_id,role,content,model,created_at) VALUES (?,?,?,?,?,?)')
    .run('hidden-tool', id, 'system', 'HIDDEN TOOL OR SYSTEM RECORD', null, Date.now() + 1);
  const reviewed = await review(id);
  assert.equal(reviewed.messages.length, 1);
  assert.doesNotMatch(JSON.stringify(reviewed), /PRIVATE FILE BODY|secret\.txt|HIDDEN TOOL/);
  assert.match(reviewed.messages[0].content, /omitted/);
  const response = await create(id), share = await response.json();
  const stored = sqlite.prepare('SELECT snapshot FROM public_shares WHERE id=?').get(share.id).snapshot;
  assert.doesNotMatch(stored, /PRIVATE FILE BODY|secret\.txt|HIDDEN TOOL/);
  assert.deepEqual(publicShareMessages([{ role: 'user', content: 'Visible', created_at: 1, user_id: 'private-owner', file: { body: secret }, usage_id: 'private-usage', toolResult: secret }]),
    [{ role: 'user', content: 'Visible', model: null, created_at: 1 }]);
});

test('a changed title or message invalidates the reviewed snapshot without publishing it', async () => {
  const id = seed(), reviewed = await review(id);
  sqlite.prepare('UPDATE conversations SET title=? WHERE id=?').run('New private title', id);
  let response = await call('shares', 'POST', { conversationId: id, previewHash: reviewed.previewHash, privacyConfirmed: true });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'SHARE_PREVIEW_CHANGED');
  const refreshed = await review(id);
  sqlite.prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)').run('new-private-turn', id, 'assistant', 'Unreviewed private addition', Date.now() + 1);
  response = await call('shares', 'POST', { conversationId: id, previewHash: refreshed.previewHash, privacyConfirmed: true });
  assert.equal(response.status, 409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM public_shares').get().n, 0);
  const share = await (await create(id)).json();
  sqlite.prepare('UPDATE messages SET content=? WHERE id=?').run('Changed after publication', 'new-private-turn');
  assert.equal((await readPublicShare(env.DB, share.token)).messages.at(-1).content, 'Unreviewed private addition');
});

test('expiry is enforced at the exact boundary by the shared reader, JSON API and SSR page', async () => {
  const id = seed(), share = await (await create(id)).json();
  assert.ok(await readPublicShare(env.DB, share.token, share.expires_at - 1));
  assert.equal(await readPublicShare(env.DB, share.token, share.expires_at), null);
  sqlite.prepare('UPDATE public_shares SET expires_at=? WHERE id=?').run(Date.now() - 1, share.id);
  user = null;
  const response = await call('public-shares/' + share.token);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
  await assert.rejects(() => PublicSharePage({ token: share.token, signedIn: false }), /NOT_FOUND/);
  user = { userId: 'alice', email: 'alice@example.test' };
  const list = await (await call('shares')).json(); assert.equal(list.shares[0].status, 'expired');
  assert.equal((await call('shares/' + share.id, 'PATCH', { expiresInDays: null })).status, 404);
});

test('legacy links remain available until their owner changes expiry or revokes them', async () => {
  const id = seed(), token = 'f'.repeat(64);
  sqlite.prepare('INSERT INTO public_shares (id,user_id,conversation_id,token,title,snapshot,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('legacy-share', 'alice', id, token, 'Legacy', '[{"role":"user","content":"Old"}]', 1);
  assert.equal((await readPublicShare(env.DB, token)).expires_at, null);
  user = { userId: 'bob', email: 'bob@example.test' };
  assert.equal((await call('shares/legacy-share', 'PATCH', { expiresInDays: 1 })).status, 404);
  assert.equal((await call('shares/legacy-share', 'DELETE')).status, 404);
  user = { userId: 'alice', email: 'alice@example.test' };
  assert.equal((await call('shares/legacy-share', 'PATCH', { expiresInDays: 1 })).status, 200);
  assert.ok((await readPublicShare(env.DB, token)).expires_at > Date.now());
  assert.equal((await call('shares/legacy-share', 'DELETE')).status, 200);
  assert.equal((await call('public-shares/' + token)).status, 404);
  await assert.rejects(() => PublicSharePage({ token, signedIn: false }), /NOT_FOUND/);
  assert.ok(sqlite.prepare('SELECT id FROM conversations WHERE id=?').get(id));
});

test('pending deletion immediately hides existing shares through the shared reader, JSON API and SSR without affecting another owner', async () => {
  const now=Date.now(), aliceToken='a'.repeat(64), bobToken='b'.repeat(64);
  const aliceChat=seed('alice-deleting','alice'), bobChat=seed('bob-retained','bob');
  const insert=sqlite.prepare('INSERT INTO public_shares (id,user_id,conversation_id,token,title,snapshot,created_at) VALUES (?,?,?,?,?,?,?)');
  insert.run('alice-share','alice',aliceChat,aliceToken,'Alice share','[{"role":"user","content":"Alice private snapshot"}]',now);
  insert.run('bob-share','bob',bobChat,bobToken,'Bob share','[{"role":"user","content":"Bob retained snapshot"}]',now);
  assert.ok(await readPublicShare(env.DB,aliceToken));
  assert.ok(await readPublicShare(env.DB,bobToken));

  // The worker has not claimed this job, revoked the shares, or removed records.
  sqlite.prepare('INSERT INTO account_deletion_jobs (id,user_id,requested_at,updated_at) VALUES (?,?,?,?)')
    .run('alice-deletion','alice',now,now);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM public_shares').get().n,2);
  assert.equal(sqlite.prepare("SELECT worker_token FROM account_deletion_jobs WHERE id='alice-deletion'").get().worker_token,null);
  assert.equal(await readPublicShare(env.DB,aliceToken),null);
  assert.equal((await readPublicShare(env.DB,bobToken)).messages[0].content,'Bob retained snapshot');

  user=null;
  assert.equal((await call('public-shares/'+aliceToken)).status,404);
  assert.equal((await call('public-shares/'+bobToken)).status,200);
  await assert.rejects(()=>PublicSharePage({token:aliceToken,signedIn:false}),/NOT_FOUND/);
  assert.match(renderToStaticMarkup(await PublicSharePage({token:bobToken,signedIn:false})),/Bob retained snapshot/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM public_shares').get().n,2,'read isolation must not rely on worker-side deletion');
});

test('legacy public reads allowlist fields, strip attachments again and render untrusted text as text', async () => {
  const id = seed(), token = 'c'.repeat(64);
  sqlite.prepare('INSERT INTO public_shares (id,user_id,conversation_id,token,title,snapshot,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('legacy-unsafe', 'alice', id, token, '<script>titleAttack()</script>', JSON.stringify([
      { role: 'user', content: '<img src=x onerror="attack()">\n\n<attached_document name="secret">PRIVATE FILE</attached_document>', user_id: 'hidden', file: { body: 'SECRET BODY' } },
      { role: 'assistant', content: '<script>messageAttack()</script> & javascript:alert(1)' },
      { role: 'tool', content: 'HIDDEN TOOL' },
    ]), 1);
  user = null;
  const response = await call('public-shares/' + token); assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE FILE|SECRET BODY|user_id|HIDDEN TOOL/);
  const html = renderToStaticMarkup(await PublicSharePage({ token, signedIn: false }));
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
  assert.match(html, /href="\/signin-with-chatgpt\?return_to=%2Fchat"/);
  assert.doesNotMatch(html, /\/auth\/google/);
  assert.match(html, /&lt;script&gt;titleAttack/);
  assert.match(html, /&lt;img src=x/);
  assert.doesNotMatch(html, /PRIVATE FILE|SECRET BODY|HIDDEN TOOL/);
  sqlite.prepare('UPDATE public_shares SET snapshot=? WHERE id=?').run('{invalid json', 'legacy-unsafe');
  assert.equal((await call('public-shares/' + token)).status, 404);
  await assert.rejects(() => PublicSharePage({ token, signedIn: false }), /NOT_FOUND/);
});
