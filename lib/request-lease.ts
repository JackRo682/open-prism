/** Every acquisition has a new identity, even when clocks repeat. Old request
 * cleanup must never remove a lease acquired by a newer request. */
export type RequestLease = { key: string; token: string; expiresAt: number };

export async function acquireRequestLease(sql: D1Database, key: string, durationMs: number, now = Date.now()): Promise<RequestLease | null> {
  if (!key || key.length > 300 || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 900000) throw new Error('Invalid request lease.');
  const token = crypto.randomUUID(), expiresAt = now + durationMs;
  const claimed = await sql.prepare(`INSERT INTO rate_limits (key,count,expires_at,lease_token) VALUES (?,1,?,?)
    ON CONFLICT(key) DO UPDATE SET count=1,expires_at=excluded.expires_at,lease_token=excluded.lease_token
    WHERE rate_limits.expires_at<=? RETURNING key`).bind(key, expiresAt, token, now).first();
  return claimed ? { key, token, expiresAt } : null;
}

export async function releaseRequestLease(sql: D1Database, lease: RequestLease): Promise<void> {
  await sql.prepare('DELETE FROM rate_limits WHERE key=? AND lease_token=?').bind(lease.key, lease.token).run();
}

export async function requestLeaseIsCurrent(sql: D1Database, lease: RequestLease, now = Date.now()): Promise<boolean> {
  return !!await sql.prepare('SELECT key FROM rate_limits WHERE key=? AND lease_token=? AND expires_at>?').bind(lease.key, lease.token, now).first();
}

/** Place first in the same D1 batch as protected writes. If the lease changed
 * or disappeared, the NOT NULL constraint aborts the entire transaction. An
 * ordinary read followed by a write would leave a race between those calls. */
export function requestLeaseFence(sql: D1Database, lease: RequestLease, now = Date.now()): D1PreparedStatement {
  return sql.prepare(`INSERT INTO rate_limits (key,count,expires_at,lease_token)
    VALUES (?,CASE WHEN EXISTS (SELECT 1 FROM rate_limits WHERE key=? AND lease_token=? AND expires_at>?) THEN 1 ELSE NULL END,?,?)
    ON CONFLICT(key) DO UPDATE SET count=excluded.count`)
    .bind(lease.key, lease.key, lease.token, now, lease.expiresAt, lease.token);
}
