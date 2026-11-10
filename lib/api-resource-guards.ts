import { apiBodyLimit } from './request-security';

type ReadPolicy = { group: 'read' | 'search' | 'download'; limit: number };

/** Shared account counters have fixed keys, so random URLs cannot grow the
 * rate-limit table. They complement the existing chat and write quotas. */
export function accountReadPolicy(request: Request): ReadPolicy | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const path = new URL(request.url).pathname;
  if (path === '/api/bootstrap') return null; // This projection does not query D1.
  if (path === '/api/search') return { group: 'search', limit: 30 };
  if (/^\/api\/(?:files|artifacts)\/[^/]+$/.test(path)
    || /^\/api\/media\/[^/]+\/content$/.test(path)) return { group: 'download', limit: 120 };
  return { group: 'read', limit: 180 };
}

export async function allowAccountRead(sql: D1Database, owner: string, request: Request, now = Date.now()): Promise<boolean> {
  const policy = accountReadPolicy(request);
  if (!policy) return true;
  const row = await sql.prepare(`INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
      expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at<=? OR count<? RETURNING key`)
    .bind(`api:${policy.group}:${owner}`, now + 60_000, now, now, now, policy.limit).first();
  return !!row;
}

/** Reject bursts of expensive anonymous reads using stable, site-wide
 * counters. No caller-supplied path, IP, cookie, or share token becomes a key.
 * These are resource ceilings, not a substitute for edge/per-network WAF rules. */
export async function allowPublicRead(sql: D1Database, request: Request, now = Date.now()): Promise<boolean> {
  if (request.method !== 'GET') return true;
  const path = new URL(request.url).pathname;
  const group = path === '/api/guest/bootstrap' ? 'guest-bootstrap'
    : path === '/api/upgrade' ? 'upgrade'
    : /^\/api\/public-shares\/[a-f0-9]{64}$/.test(path) ? 'share' : null;
  if (!group) return true;
  const row = await sql.prepare(`INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
      expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at<=? OR count<600 RETURNING key`)
    .bind(`api:public:${group}`, now + 60_000, now, now, now).first();
  return !!row;
}

/** Bound simultaneous request preparation in each Worker isolate before any
 * body is read. Every request reserves its full enforced maximum, including
 * requests that lie about Content-Length. Releases are idempotent. Existing
 * durable chat/browser/media locks continue to govern work after streaming
 * response headers have been returned. */
export function createApiAdmissionController(options: { maxRequests?: number; maxBodyBytes?: number } = {}) {
  const maxRequests = options.maxRequests ?? 32;
  const maxBodyBytes = options.maxBodyBytes ?? 16 * 1024 * 1024;
  let active = 0, reserved = 0;
  return {
    acquire(request: Request): (() => void) | null {
      const path = new URL(request.url).pathname;
      if (path !== '/api' && !path.startsWith('/api/')) return () => {};
      const bytes = request.body && !['GET', 'HEAD'].includes(request.method) ? apiBodyLimit(request) : 0;
      if (active >= maxRequests || reserved + bytes > maxBodyBytes) return null;
      active++; reserved += bytes;
      let released = false;
      return () => {
        if (released) return;
        released = true; active--; reserved -= bytes;
      };
    },
  };
}

type Readiness = { status: 'ready'; service: 'open-prism' } | { status: 'unavailable'; code: string };
type Probe = { value?: Readiness; until: number; pending?: Promise<Readiness> };
const readiness = new WeakMap<D1Database, Probe>();

/** Cache and coalesce the anonymous readiness probe. Timed-out D1 operations
 * stay in flight until they actually settle, so retries cannot pile up a new
 * batch each time the response deadline expires. No user data is cached. */
export async function checkReadiness(env: Pick<Cloudflare.Env, 'DB' | 'BUCKET' | 'GEMINI_API_KEY'>, timeoutMs = 3000): Promise<Readiness> {
  if (!env.DB) return { status: 'unavailable', code: 'DATABASE_NOT_READY' };
  if (!env.BUCKET) return { status: 'unavailable', code: 'STORAGE_NOT_READY' };
  if (!env.GEMINI_API_KEY) return { status: 'unavailable', code: 'PROVIDER_NOT_READY' };
  const sql = env.DB, now = Date.now();
  let entry = readiness.get(sql);
  if (!entry) { entry = { until: 0 }; readiness.set(sql, entry); }
  if (entry.value && entry.until > now) return entry.value;
  if (!entry.pending) {
    const current = entry;
    current.pending = Promise.resolve().then(() => sql.batch([
      'usage', 'scheduled_tasks', 'media_assets', 'browser_sessions', 'work_artifacts',
      'chat_operations', 'conversation_reports', 'conversation_revisions', 'security_alerts', 'account_deletion_jobs',
    ].map(table => sql.prepare(`SELECT id FROM ${table} LIMIT 1`)))).then(
      (): Readiness => ({ status: 'ready', service: 'open-prism' }),
      (): Readiness => ({ status: 'unavailable', code: 'DATABASE_NOT_READY' }),
    ).then(value => {
      current.value = value;
      current.until = Date.now() + (value.status === 'ready' ? 10_000 : 2000);
      current.pending = undefined;
      return value;
    });
  }
  const pending = entry.pending;
  if (!pending) return entry.value ?? { status: 'unavailable', code: 'DATABASE_NOT_READY' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<Readiness>(resolve => { timer = setTimeout(() => {
        const value: Readiness = { status: 'unavailable', code: 'DATABASE_NOT_READY' };
        entry!.value = value; entry!.until = Date.now() + 2000;
        resolve(value);
      }, timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
