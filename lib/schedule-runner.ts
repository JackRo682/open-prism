export type RunnerEnvironment = {
  SCHEDULE_RUNNER_ENABLED?: string; SCHEDULE_RUNNER_SECRET?: string;
  SCHEDULE_RUNNER_SECRET_EXPIRES_AT?: string; SCHEDULE_RUNNER_PREVIOUS_SECRET?: string;
  SCHEDULE_RUNNER_PREVIOUS_SECRET_EXPIRES_AT?: string;
};
const validSecret = (secret: string | undefined): secret is string => !!secret && secret.length >= 32 && secret.length <= 512 && /^[\x21-\x7e]+$/.test(secret);
function expiry(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical ? parsed : null;
}
export function runnerReady(env: RunnerEnvironment, now = Date.now()): boolean {
  return env.SCHEDULE_RUNNER_ENABLED === 'true' && validSecret(env.SCHEDULE_RUNNER_SECRET)
    && (env.SCHEDULE_RUNNER_SECRET_EXPIRES_AT === undefined || (expiry(env.SCHEDULE_RUNNER_SECRET_EXPIRES_AT) ?? 0) > now);
}
async function sameSecret(provided: string, expected: string): Promise<boolean> {
  const encode = new TextEncoder();
  const hashes = await Promise.all([provided, expected].map(value => crypto.subtle.digest('SHA-256', encode.encode(value))));
  const a = new Uint8Array(hashes[0]), b = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
/** The previous key is accepted only for an explicit, bounded rotation window.
 * Removing it revokes it immediately. Neither key is ever returned or logged. */
export async function authenticateRunner(request: Request, env: RunnerEnvironment, now = Date.now()): Promise<'current' | 'previous' | null> {
  if (!runnerReady(env, now)) return null;
  const header = request.headers.get('authorization') || '';
  if (header.length > 519 || !header.startsWith('Bearer ')) return null;
  const supplied = header.slice(7);
  if (!validSecret(supplied)) return null;
  const previousExpires = expiry(env.SCHEDULE_RUNNER_PREVIOUS_SECRET_EXPIRES_AT);
  const previousEnabled = validSecret(env.SCHEDULE_RUNNER_PREVIOUS_SECRET) && previousExpires !== null
    && previousExpires > now && previousExpires <= now + 24 * 60 * 60 * 1000;
  // Always perform both comparisons to avoid exposing which rotation slot matched.
  const [current, previous] = await Promise.all([
    sameSecret(supplied, env.SCHEDULE_RUNNER_SECRET!),
    sameSecret(supplied, previousEnabled ? env.SCHEDULE_RUNNER_PREVIOUS_SECRET! : env.SCHEDULE_RUNNER_SECRET!),
  ]);
  return current ? 'current' : previousEnabled && previous ? 'previous' : null;
}

export async function allowRunnerInvocation(sql: D1Database, now = Date.now()): Promise<boolean> {
  const row = await sql.prepare(`INSERT INTO rate_limits (key,count,expires_at) VALUES ('schedule-runner:invoke',1,?)
    ON CONFLICT(key) DO UPDATE SET count=1,expires_at=excluded.expires_at
    WHERE rate_limits.expires_at<=? RETURNING key`).bind(now + 60000, now).first();
  return !!row;
}
