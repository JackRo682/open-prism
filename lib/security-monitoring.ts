type SecurityCategory = 'authentication_failed' | 'access_denied' | 'rate_limit' | 'upload_rejected' | 'payment_anomaly' | 'server_error' | 'runner_failure' | 'slow_request' | 'resource_spike' | 'deletion_retry' | 'admin_adjustment';
type Severity = 'warning' | 'high';
export type SecurityEvent = { category: SecurityCategory; route: string; requestId: string; status: number };
const windowMs = 5 * 60 * 1000;
const rules: Record<SecurityCategory, { threshold: number; severity: Severity }> = {
  authentication_failed: { threshold: 10, severity: 'warning' }, access_denied: { threshold: 5, severity: 'warning' },
  rate_limit: { threshold: 10, severity: 'warning' }, upload_rejected: { threshold: 5, severity: 'warning' },
  payment_anomaly: { threshold: 1, severity: 'high' }, server_error: { threshold: 3, severity: 'high' },
  runner_failure: { threshold: 1, severity: 'high' }, slow_request: { threshold: 3, severity: 'warning' },
  resource_spike: { threshold: 50, severity: 'warning' },
  deletion_retry: { threshold: 3, severity: 'warning' }, admin_adjustment: { threshold: 1, severity: 'warning' },
};

/** Only fixed route labels enter storage. Never retain URL IDs, queries, IPs,
 * cookies, prompts, filenames, provider bodies, or authentication headers. */
export function securityRoute(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'api') return '/other';
  const head = segments[1];
  if (head === 'tasks' && segments[2] === 'run-due') return '/api/tasks/run-due';
  if (head === 'payments' && segments[2] === 'webhook') return '/api/payments/webhook';
  if (head === 'account' && segments[2] === 'data') return '/api/account/data';
  if (head === 'media' && segments[2] === 'reference') return '/api/media/reference';
  if (['chat', 'guest', 'files', 'media', 'tasks', 'payments', 'admin', 'conversations', 'shares', 'public-shares', 'settings', 'billing', 'usage', 'search', 'integrations', 'bootstrap', 'health', 'auth', 'generation'].includes(head)) return '/api/' + head;
  return '/api/other';
}

export function classifySecurityResponse(request: Request, response: Response, requestId: string, durationMs: number): SecurityEvent | null {
  const route = securityRoute(new URL(request.url).pathname), status = response.status;
  let category: SecurityCategory | undefined;
  if (route.startsWith('/api/payments') && [400, 401, 403, 409, 422, 502].includes(status)) category = 'payment_anomaly';
  else if (status === 401) category = 'authentication_failed';
  else if (status === 403) category = 'access_denied';
  else if (status === 429) category = 'rate_limit';
  else if (['/api/files', '/api/media/reference'].includes(route) && [400, 413, 415, 422].includes(status)) category = 'upload_rejected';
  else if (status >= 500 && status !== 503) category = 'server_error';
  else if (durationMs >= 120000) category = 'slow_request';
  return category ? { category, route, requestId, status } : null;
}

/** Call only after validation and budget reservation. Dispatch first so awaiting
 * telemetry never opens a cancellation gap before the provider attempt. All
 * generation flows share one bounded counter; no owner or spend enters it. */
export async function trackProviderAttempt<T>(sql: D1Database, requestId: string, start: () => Promise<T>): Promise<T> {
  const attempt = start();
  const [outcome] = await Promise.allSettled([
    attempt,
    recordSecurityEvent(sql, { category: 'resource_spike', route: '/api/generation', requestId, status: 202 }),
  ]);
  if (outcome.status === 'rejected') throw outcome.reason;
  return outcome.value;
}

/** An SSE response's HTTP status/initial latency do not describe its eventual
 * result. Call once when generation finishes, with a safe outcome status. */
export async function recordGenerationOutcome(sql: D1Database, outcome: {
  route: string; requestId: string; status: number; startedAt: number;
}, now = Date.now()): Promise<void> {
  const event = { route: outcome.route, requestId: outcome.requestId, status: outcome.status };
  if (outcome.status >= 500 && outcome.status <= 599) await recordSecurityEvent(sql, { ...event, category: 'server_error' }, now);
  if (Number.isFinite(outcome.startedAt) && now - outcome.startedAt >= 120000) await recordSecurityEvent(sql, { ...event, category: 'slow_request' }, now);
}

/** Aggregated, deduplicated alerts are persisted for operators and emitted as
 * structured Worker logs. Recording failures never replace an API result. */
export async function recordSecurityEvent(sql: D1Database | undefined, event: SecurityEvent, now = Date.now()): Promise<void> {
  if (!Object.hasOwn(rules, event.category)) return;
  const rule = rules[event.category];
  const route = securityRoute(event.route), requestId = /^[a-zA-Z0-9_-]{1,100}$/.test(event.requestId) ? event.requestId : 'unavailable';
  const status = Number.isSafeInteger(event.status) && event.status >= 100 && event.status <= 599 ? event.status : 500;
  const safeEvent = { event: 'security_event', category: event.category, route, requestId, status };
  if (event.category === 'resource_spike') console.info(JSON.stringify(safeEvent));
  else console.warn(JSON.stringify(safeEvent));
  if (!sql) return;
  const windowStart = Math.floor(now / windowMs) * windowMs, key = event.category + ':' + route + ':' + windowStart;
  try {
    await sql.batch([
      sql.prepare(`INSERT INTO security_event_windows (key,category,route,event_count,window_start,last_seen,last_request_id,last_status)
        VALUES (?,?,?,1,?,?,?,?) ON CONFLICT(key) DO UPDATE SET event_count=MIN(event_count+1,1000000),
        last_seen=excluded.last_seen,last_request_id=excluded.last_request_id,last_status=excluded.last_status`)
        .bind(key, event.category, route, windowStart, now, requestId, status),
      sql.prepare(`INSERT INTO security_alerts (id,category,route,severity,event_count,first_seen,last_seen,last_request_id,last_status,state)
        SELECT key,category,route,?,event_count,window_start,last_seen,last_request_id,last_status,'open'
        FROM security_event_windows WHERE key=? AND event_count>=?
        ON CONFLICT(id) DO UPDATE SET event_count=excluded.event_count,last_seen=excluded.last_seen,
        last_request_id=excluded.last_request_id,last_status=excluded.last_status`)
        .bind(rule.severity, key, rule.threshold),
    ]);
    const cleanup = await sql.prepare(`INSERT INTO rate_limits (key,count,expires_at) VALUES ('security:retention',1,?)
      ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at
      WHERE rate_limits.expires_at<=? RETURNING key`).bind(now + 3600000, now).first();
    if (cleanup) await pruneSecurityEvents(sql, now);
  } catch {
    console.error(JSON.stringify({ event: 'security_monitoring_unavailable', requestId }));
  }
}

export async function securityOverview(sql: D1Database, now = Date.now()) {
  await pruneSecurityEvents(sql, now);
  const [alerts, recent, usage, deletions] = await Promise.all([
    sql.prepare('SELECT * FROM security_alerts ORDER BY last_seen DESC LIMIT 100').all(),
    sql.prepare('SELECT category,SUM(event_count) AS events FROM security_event_windows WHERE window_start>=? GROUP BY category').bind(now - 3600000).all(),
    sql.prepare("SELECT COUNT(*) AS requests,SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS failed FROM usage WHERE created_at>=?").bind(now - 3600000).first(),
    sql.prepare("SELECT COUNT(*) AS pending,MIN(requested_at) AS oldestRequestedAt,SUM(CASE WHEN worker_token IS NOT NULL THEN 1 ELSE 0 END) AS claimed,(SELECT COUNT(*) FROM account_data_operations WHERE started_at<?) AS operationsOver15Minutes FROM account_deletion_jobs WHERE status='pending'").bind(now - 900000).first(),
  ]);
  return { alerts: alerts.results, lastHour: recent.results, usage, deletions, thresholds: rules, eventRetentionDays: 1, alertRetentionDays: 30,
    delivery: { database: true, structuredWorkerLogs: true, externalNotifications: false } };
}

async function pruneSecurityEvents(sql: D1Database, now: number) {
  await sql.batch([
    sql.prepare('DELETE FROM security_event_windows WHERE window_start<?').bind(now - 86400000),
    sql.prepare('DELETE FROM security_alerts WHERE last_seen<?').bind(now - 30 * 86400000),
  ]);
}

export async function acknowledgeSecurityAlert(sql: D1Database, id: unknown, now = Date.now()): Promise<boolean> {
  if (typeof id !== 'string' || id.length > 200 || !/^[a-z0-9_:/-]+$/.test(id)) return false;
  return !!await sql.prepare("UPDATE security_alerts SET state='acknowledged',acknowledged_at=? WHERE id=? RETURNING id").bind(now, id).first();
}
