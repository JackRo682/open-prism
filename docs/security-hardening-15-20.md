# Security hardening: uploads, monitoring, billing, runners, concurrency, deletion

This patch addresses review items 15–20 against the current Sites source. The
percentages in the original review are not measured incident frequencies and
are not used as security guarantees.

## Implemented controls

| Area | Behavior |
| --- | --- |
| Text uploads | A bounded, single-file multipart parser; strict UTF-8; extension/MIME validation; unsafe filename rejection; text-only storage and attachment responses. Source text is never executed by the application. |
| Reference images | Extension/MIME/content agreement, bounded dimensions, complete PNG/JPEG/WebP container validation, rejection of truncation/trailing payloads/animation, and full bounded PNG raster decompression validation. |
| File delivery | Private/no-store, nosniff, same-origin resource policy, and sandbox CSP. Generated artifacts and text downloads force attachment disposition; media is limited to the expected type for its kind. |
| Monitoring | Fixed-category security events with request IDs; five-minute aggregate thresholds; deduplicated durable alerts; an authenticated administrator dashboard/API with acknowledgment. No prompt, email, filename, IP, cookie, authorization header, URL query or raw provider error is stored in the security-event tables. |
| Billing | Append-only ledger triggers, signed safe-integer amount/balance checks, verified cancellation statuses and same-owner/live-reservation settlement. Existing verified refund, payment idempotency and launch gating remain in force. |
| Runner credentials | Strict 32–512-character Bearer credentials, constant-work hash comparisons, optional current-key expiry and an explicitly expiring previous-key rotation slot. Previous-key overlap is limited to the final 24 hours before its expiry. |
| Runner scope | Rejects caller-supplied task arguments/query parameters; claims only database-scheduled due tasks, maximum three; one invocation/minute and one active runner lease. Structured execution audit records counts and credential slot, never the secret or task text. |
| Concurrency | Random lease tokens for chat, conversation deletion, media polling and browser work. Cleanup matches the token. Initial/final chat writes and conversation deletion include a lease assertion in the same database transaction. |
| Workspace deletion | Durable pending jobs and storage manifests; immediate read/write barriers; waits for active producers; bounded retryable object and record cleanup; exact-owner orphan sweep; removal of revision history and report snapshots. Accounting reservations and sign-in identity remain. |

Apply all migrations through `0012_account_deletion.sql` through the Sites
deployment workflow. The migration adds controls without deleting existing
workspace data. Read [data-retention.md](data-retention.md) for the per-table
policy, interrupted-worker recovery and backup-restoration requirements.

## Administrator monitoring

`ADMIN_USER_ID` must match a verified application user ID. An email address is
not an administrator credential. The existing `/admin` page includes real
security alerts; `GET /api/admin/security` includes recent aggregates, usage
counts, pending deletion counts and old operation counts. `PATCH` on that path
acknowledges an alert by its returned `id`. All operations enforce administrator
identity and ordinary same-origin mutation checks.

Default five-minute thresholds are ten authentication failures, five access
denials, ten rate-limit responses, five rejected uploads, three server errors,
three slow requests and three failed deletion attempts. Payment anomalies,
scheduled-runner failures and administrator reconciliations alert immediately.
A shared counter also alerts on 50 generation provider attempts per five-minute
window across signed-in chat, guest chat and initial media generation. Optional
title generation counts separately; rejected requests, replays, polling and
downloads do not. Stream monitoring measures full generation time and records
provider/internal failures while excluding user cancellation. This is a volume
signal, not exact currency-spend monitoring.

These are operational starting points; they are not probabilities of compromise.

Event buckets are retained for one day and alerts for 30 days. Cleanup runs at
most hourly during event ingestion and when the administrator reads the
overview. With no application activity, physical cleanup waits for the next
such invocation. Alert delivery currently means database records and structured
Worker logs. Email, Slack, paging and WAF log export are separate operational
integrations and are not claimed to be configured.

## Runner rotation

Use the existing scheduler's secret store and server environment configuration.
Do not put runner credentials in a URL, browser bundle, repository or log.

1. Generate a new high-entropy current key in the approved secret manager.
2. Move the existing current value to `SCHEDULE_RUNNER_PREVIOUS_SECRET` and set
   `SCHEDULE_RUNNER_PREVIOUS_SECRET_EXPIRES_AT` to an explicit UTC ISO timestamp
   no more than 24 hours away. Configure the new `SCHEDULE_RUNNER_SECRET`.
3. Update the scheduler's Bearer credential. Confirm successful execution audit
   records show `credentialVersion: "current"`.
4. Remove the previous-key settings. Old credentials are then rejected.

`SCHEDULE_RUNNER_SECRET_EXPIRES_AT` optionally expires the current key. Malformed
or expired timestamps fail closed. A disabled/unconfigured runner stays disabled;
this patch does not create an external schedule or increase inference budgets.

## Verification and limits

Tests use actual SQL migrations, isolated SQLite databases, provider transports,
and native Workerd where runtime behavior matters. The suites cover malformed,
oversized and disguised uploads; full PNG decompression; safe headers; immutable
ledger enforcement; payment/refund retries; expired and rotated credentials;
security-alert thresholds; expired/reacquired lock races; transactional lease
fencing; interrupted deletion and ownership isolation.

JPEG and WebP receive complete-container validation, not full pixel entropy
decoding. No malware-scanning service or Cloudflare Images binding is configured.
Those controls require an isolated, maintained decoder/scanner before adding
higher-risk processing. [OWASP's upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
recommends multiple independent controls because MIME or signature validation
alone is insufficient.

Production notification delivery, WAF rules, backup expiration, live payments and external scheduling require their own live evidence.
The patch does not enable commercial payments, change approved usage limits,
invent a backup guarantee, or activate an unconfigured authentication rollout.
