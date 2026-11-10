# Workspace deletion and retention

`DELETE /api/account/data` resets the authenticated user's OpenPrism workspace.
It does not close the external sign-in account or remove the OpenPrism identity.
The API distinguishes a completed deletion (`200`, `status: "complete"`) from an
accepted, incomplete deletion (`202`, `status: "pending"`). A storage error must
never be presented as successful deletion.

## Deletion lifecycle

1. Create or reuse one durable pending deletion job for the authenticated owner.
   Database triggers immediately reject new content inserts and updates. API and
   server-rendered reads must check the pending barrier. Public share reads must
   exclude owners with pending jobs; stored share rows are also revoked on the
   first worker pass.
2. Wait for all account mutation operations to drain. Every authenticated
   mutation, including scheduled work, must register an operation atomically
   against the pending-job barrier. Streaming operations end when their producer
   finishes all persistence and cleanup, rather than merely when the browser
   disconnects or stops reading the stream.
3. Queue stored-object keys in a durable manifest. Delete at most 50 keys per
   invocation, preserving retry state if the R2 request or the following database
   update fails. Already-absent keys can be retried safely.
4. List the exact authenticated owner prefix in R2. This finds orphaned uploads
   left between a storage write and its database insert. The sweep never follows
   a database pointer into another owner's namespace. Missing storage bindings,
   failed listings, and ownership mismatches keep the job pending.
5. Remove workspace database records in batches of at most 500 rows per table.
   Remove revision snapshots, feedback, report snapshots, and chat operation
   history as well as the current conversation and file rows. Preserve the
   barrier until the namespace, content tables, and retry manifest are empty.
6. Mark the job complete. The same sign-in identity can then create a new
   workspace. A subsequent deletion request creates a new job.

Repeated `DELETE /api/account/data` calls resume the existing pending job. A
scheduled maintenance caller can use `resumePendingAccountDeletions`; that helper
handles two jobs by default and at most three per invocation. It does not create
new user deletion requests. Automatic completion still requires a configured
caller; the helper's existence does not establish a live scheduler.

## Record-by-record policy

| Data | Policy implemented by workspace deletion |
| --- | --- |
| Conversations and current messages | Remove after storage cleanup. |
| `conversation_revisions`, `conversation_revision_messages` | Remove the historical contents as well as the current messages. |
| `message_feedback`, `conversation_reports`, `chat_operations` | Remove user-owned feedback, reports/snapshots, operation details, and errors. |
| Files, notebooks, image references, generated media and work artifacts | Remove metadata and every object under the authenticated owner's R2 prefix, including unreferenced objects. |
| Workspace settings | Remove personalization, memory, skills, and preferences. |
| Scheduled tasks and saved browser captures | Remove prompts, schedules, results/captures, and stored browsing history. |
| Public share snapshots | Revoke when deletion starts and remove stored rows. |
| Usage history | Retain counts, model/rate snapshots, reservation amounts, and reconciliation identifiers so deletion does not reset quotas or credits. Remove arbitrary diagnostic text. Unfinished provider records become `error` with a fixed reconciliation note; reserved amounts are not refunded. |
| Payments, refunds, wallet ledger, account review flags | Retain for payment reconciliation and enforcement. The production accounting retention period must come from the operator's approved policy; this patch does not invent one or delete unsettled records. |
| Application identity, profile, and sessions | Retain any existing identity records because this operation resets workspace content rather than closing the sign-in account. The provider’s session-expiration policy still applies. The prepared Google identity tables do not activate the pending Google-login rollout. |
| Pending deletion jobs and active operation tokens | Retain until safely completed or explicitly recovered. Never release on an age-only timeout. |
| Object cleanup manifest | Remove after storage and content cleanup; it is never exposed in a client response. |
| Completed deletion audit | Keep minimal owner/job IDs, counts, states and timestamps for 30 days, then purge in bounded batches on new deletion requests or administrator maintenance. No conversation text, filename, object key, or raw exception is stored in the audit. |
| Current browser Canvas caches | The workspace reset UI must remove the current account's Canvas session-storage prefix and clear its in-memory drafts and content. Other tabs and previously downloaded/shared copies cannot be remotely erased by a server delete. |

The migration is additive: it creates deletion state and write barriers without
backfilling, deleting, or rewriting existing user records. Apply all migrations
through `0012_account_deletion.sql` before deploying the corresponding code.
`tests/account-deletion.test.mjs` inventories owner tables so a future table must
receive an explicit removal or retention decision.

## Interrupted request recovery

Account operation tokens and deletion-worker tokens intentionally do not expire.
An age-based unlock can let a paused request resume after deletion has finished,
recreating private data or deleting a newly created workspace. If a worker is
terminated before releasing its token, the job remains pending and access stays
blocked. The status API exposes active operation counts and whether a deletion
worker is still claimed, without exposing tokens or object keys.

For a stuck job, the operator must first establish that the original worker and
all provider callbacks that could persist content cannot resume. Inspect the
exact job and operation rows, correlate request/audit information, and reconcile
any unfinished usage. Only then remove the specific stranded operation token or
clear the specific job's worker token. Record that intervention in the operator
audit and retry the pending job. Do not clear all old tokens or all pending jobs
as a routine cleanup. A permanently blocked job is visible and recoverable;
silently reopening a workspace while a stale writer still exists is unsafe.

No provider cancellation or refund is implied by deleting workspace content.
Provider-side jobs and provider retention policies require their own confirmed
reconciliation. The retained reservation remains available for this work.

## Storage, backups, and restoration boundary

The live deletion logic relies on Cloudflare's documented [R2 read, delete, and
list consistency](https://developers.cloudflare.com/r2/reference/consistency/)
and [Workers binding delete/list API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
Keep the bucket private and serve content through authenticated, uncached API
responses. A public custom-domain cache can outlive an R2 deletion and needs
separate invalidation; this patch does not claim to inspect or configure such a
cache.

Database cleanup batches use the [D1 `batch()` transaction guarantee](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch):
a statement failure rolls the batch back. A zero-row update alone is not a
transaction failure, so completion is explicitly conditioned on empty cleanup
state and no active operations.

Deleting the live D1 rows does not erase existing recovery history. Cloudflare
currently documents [Time Travel retention](https://developers.cloudflare.com/d1/platform/limits/)
of 7 days on Workers Free and 30 days on Workers Paid. The actual production plan,
legacy database version, manual exports, and any external backup copies must be
verified separately. [Restoring to an earlier bookmark](https://developers.cloudflare.com/d1/reference/time-travel/)
can restore previously deleted data.

Before restoring a backup to a serving environment, keep user traffic disabled
and reapply all deletions completed after the restore point. A deletion audit
inside the same restored database is insufficient by itself: the operator needs
an appropriately protected audit export or other independent deletion record
covering the retained backup window. Do not make a restored copy public until
that reconciliation has finished. No backup policy, external audit export, or
provider retention configuration is asserted to be active by this code change.

## Verification

Run `node --test tests/account-deletion.test.mjs`. The suite covers all content
tables, exact owner isolation, private storage and namespace failures, interrupted
object and database cleanup, bounded pagination, overlapping worker attempts,
non-expiring operations, preserved credit/usage records, and audit retention.
`tests/account-deletion-api.test.mjs` additionally verifies pending read/write
barriers, streaming producer lifetime after cancellation, storage retries,
account isolation, and the client-visible `202` state. Scheduled execution also
registers its account operation until final task-state persistence.
