import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, index, uniqueIndex, check, primaryKey } from 'drizzle-orm/sqlite-core';
// Provider identities map to the application's existing stable owner IDs. A
// verified migration links Google without rewriting chats or wallet ledgers.
export const authAccounts = sqliteTable('auth_accounts', {
 userId:text('user_id').primaryKey().notNull(),email:text('email').notNull(),fullName:text('full_name'),picture:text('picture'),
 createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull(),
});
export const authGoogleIdentities = sqliteTable('auth_google_identities', {
 googleSubject:text('google_subject').primaryKey().notNull(),userId:text('user_id').notNull().references(()=>authAccounts.userId,{onDelete:'cascade'}),
 createdAt:integer('created_at').notNull(),
},t=>[uniqueIndex('auth_google_identity_owner').on(t.userId)]);
export const authSessions = sqliteTable('auth_sessions', {
 tokenHash:text('token_hash').primaryKey().notNull(),userId:text('user_id').notNull().references(()=>authAccounts.userId,{onDelete:'cascade'}),
 createdAt:integer('created_at').notNull(),expiresAt:integer('expires_at').notNull(),
},t=>[index('auth_sessions_owner').on(t.userId),index('auth_sessions_expiry').on(t.expiresAt)]);
export const authOAuthTransactions = sqliteTable('auth_oauth_transactions', {
 stateHash:text('state_hash').primaryKey().notNull(),browserHash:text('browser_hash').notNull(),nonceHash:text('nonce_hash').notNull(),verifier:text('verifier').notNull(),
 returnTo:text('return_to').notNull(),legacyUserId:text('legacy_user_id'),legacyEmail:text('legacy_email'),
 createdAt:integer('created_at').notNull(),expiresAt:integer('expires_at').notNull(),
},t=>[index('auth_oauth_transactions_expiry').on(t.expiresAt),index('auth_oauth_transactions_browser').on(t.browserHash)]);
export const conversations = sqliteTable('conversations', {
 id: text('id').primaryKey(), userId: text('user_id').notNull(), title: text('title').notNull(), model: text('model').notNull(),
 createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(), pinnedAt: integer('pinned_at'),
}, t => [index('conversations_owner').on(t.userId, t.updatedAt)]);
export const messages = sqliteTable('messages', {
 id: text('id').primaryKey(), conversationId: text('conversation_id').notNull().references(()=>conversations.id,{onDelete:'cascade'}),
 role: text('role').notNull(), content: text('content').notNull(), model: text('model'), createdAt: integer('created_at').notNull(),
 usageId: text('usage_id').references(() => usage.id, { onDelete: 'set null' }),
}, t => [index('messages_conversation').on(t.conversationId,t.createdAt)]);
export const usage = sqliteTable('usage', {
 id: text('id').primaryKey(), userId: text('user_id').notNull(), model: text('model').notNull(), provider: text('provider').notNull(),
 inputTokens: integer('input_tokens').notNull().default(0), outputTokens: integer('output_tokens').notNull().default(0),
 status: text('status').notNull(), error: text('error'), duration: integer('duration').notNull().default(0), createdAt: integer('created_at').notNull(),
 rateSnapshot:text('rate_snapshot'),reservedAmount:integer('reserved_amount').notNull().default(0),
}, t => [index('usage_owner').on(t.userId,t.createdAt)]);
export const files = sqliteTable('files', {
 id: text('id').primaryKey(), userId: text('user_id').notNull(), name: text('name').notNull(), key: text('key').notNull(),
 size: integer('size').notNull(), type: text('type').notNull(), createdAt: integer('created_at').notNull(),
}, t => [index('files_owner').on(t.userId)]);
export const rateLimits = sqliteTable('rate_limits', {
 key: text('key').primaryKey(), count: integer('count').notNull(), expiresAt: integer('expires_at').notNull(), leaseToken: text('lease_token'),
});
export const walletEvents = sqliteTable('wallet_events', {
 id:text('id').primaryKey(),userId:text('user_id').notNull(),mode:text('mode').notNull(),kind:text('kind').notNull(),
 amount:integer('amount').notNull(),reference:text('reference').notNull().unique(),createdAt:integer('created_at').notNull(),
},t=>[index('wallet_owner').on(t.userId,t.mode,t.createdAt)]);
export const payments = sqliteTable('payments', {
 id:text('id').primaryKey(),userId:text('user_id').notNull(),amount:integer('amount').notNull(),mode:text('mode').notNull(),
 status:text('status').notNull(),paymentKey:text('payment_key').unique(),createdAt:integer('created_at').notNull(),
 candidatePaymentKey:text('candidate_payment_key'),productId:text('product_id'),orderName:text('order_name'),productSnapshot:text('product_snapshot'),
 checkoutRequestId:text('checkout_request_id'),currency:text('currency').notNull().default('KRW'),
 termsVersion:text('terms_version'),termsHash:text('terms_hash'),consentSnapshot:text('consent_snapshot'),consentedAt:integer('consented_at'),
 refundedAmount:integer('refunded_amount').notNull().default(0),paidAt:integer('paid_at'),expiresAt:integer('expires_at'),
 updatedAt:integer('updated_at'),lastError:text('last_error'),providerStatus:text('provider_status'),
},t=>[index('payments_owner').on(t.userId,t.createdAt),uniqueIndex('payments_checkout_request').on(t.userId,t.mode,t.checkoutRequestId)]);
export const paymentRefunds = sqliteTable('payment_refunds', {
 id:text('id').primaryKey().notNull(),paymentId:text('payment_id').notNull().references(()=>payments.id),
 requestId:text('request_id').notNull().unique(),amount:integer('amount').notNull(),baselineRefunded:integer('baseline_refunded').notNull(),
 reason:text('reason').notNull(),status:text('status').notNull(),idempotencyKey:text('idempotency_key').notNull().unique(),
 providerCancelKey:text('provider_cancel_key'),submittedAt:integer('submitted_at'),completedAt:integer('completed_at'),lastError:text('last_error'),
 lockToken:text('lock_token'),lockedUntil:integer('locked_until'),
 createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull(),
},t=>[
 index('payment_refunds_payment').on(t.paymentId,t.createdAt),
 check('payment_refunds_amount_check',sql`${t.amount} > 0 AND ${t.baselineRefunded} >= 0`),
 check('payment_refunds_status_check',sql`${t.status} IN ('pending','succeeded','failed','review')`),
]);
export const billingConfig = sqliteTable('billing_config', {
 key:text('key').primaryKey(),value:text('value').notNull(),updatedAt:integer('updated_at').notNull(),
});
export const accountFlags = sqliteTable('account_flags', {
 userId:text('user_id').primaryKey(),reason:text('reason').notNull(),createdAt:integer('created_at').notNull(),
});
export const workspaceSettings = sqliteTable('workspace_settings', {
 userId: text('user_id').primaryKey(), settings: text('settings').notNull(), updatedAt: integer('updated_at').notNull(),
});
export const publicShares = sqliteTable('public_shares', {
 id: text('id').primaryKey(), userId: text('user_id').notNull(),
 conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
 token: text('token').notNull().unique(), title: text('title').notNull(), snapshot: text('snapshot').notNull(), createdAt: integer('created_at').notNull(),
 expiresAt: integer('expires_at'),
}, t => [index('public_shares_owner').on(t.userId, t.createdAt)]);

export const scheduledTasks = sqliteTable('scheduled_tasks', {
 id: text('id').primaryKey().notNull(), userId: text('user_id').notNull(),
 title: text('title').notNull(), prompt: text('prompt').notNull(), model: text('model').notNull(),
 timezone: text('timezone').notNull(), recurrence: text('recurrence').notNull(),
 scheduledAt: integer('scheduled_at').notNull(), nextRun: integer('next_run'), lastRun: integer('last_run'),
 lastError: text('last_error'), lastConversationId: text('last_conversation_id'),
 enabled: integer('enabled').notNull().default(0), status: text('status').notNull().default('draft'),
 runToken: text('run_token'), lockedUntil: integer('locked_until'),
 createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, t => [
 index('scheduled_tasks_owner').on(t.userId, t.createdAt),
 index('scheduled_tasks_due').on(t.enabled, t.nextRun),
 check('scheduled_tasks_recurrence_check', sql`${t.recurrence} IN ('once','daily','weekly')`),
 check('scheduled_tasks_enabled_check', sql`${t.enabled} IN (0,1)`),
 check('scheduled_tasks_status_check', sql`${t.status} IN ('draft','active','paused','running','completed','error')`),
]);

// Migration 0005 uses TEXT PRIMARY KEY without an explicit NOT NULL. Table-level
// keys preserve that SQLite nullability; the API always supplies generated IDs.
export const mediaAssets = sqliteTable('media_assets', {
 id: text('id'), userId: text('user_id').notNull(), kind: text('kind').notNull(),
 prompt: text('prompt').notNull().default(''), model: text('model').notNull().default(''),
 status: text('status').notNull(), objectKey: text('object_key'), mimeType: text('mime_type'),
 size: integer('size').notNull().default(0), job: text('job'), usageId: text('usage_id'), error: text('error'),
 createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, t => [
 primaryKey({ columns: [t.id] }), index('media_owner').on(t.userId, t.createdAt),
 check('media_assets_kind_check', sql`${t.kind} IN ('image','video','music','reference')`),
 check('media_assets_status_check', sql`${t.status} IN ('processing','complete','error')`),
]);

export const browserSessions = sqliteTable('browser_sessions', {
 id: text('id'), userId: text('user_id').notNull(), url: text('url').notNull(),
 title: text('title').notNull(), content: text('content').notNull(), createdAt: integer('created_at').notNull(),
}, t => [primaryKey({ columns: [t.id] }), index('browser_sessions_owner').on(t.userId, t.createdAt)]);

export const workArtifacts = sqliteTable('work_artifacts', {
 id: text('id'), userId: text('user_id').notNull(), conversationId: text('conversation_id').notNull(),
 name: text('name').notNull(), objectKey: text('object_key').notNull(), mimeType: text('mime_type').notNull(),
 size: integer('size').notNull(), createdAt: integer('created_at').notNull(),
}, t => [
 primaryKey({ columns: [t.id] }), index('work_artifacts_owner').on(t.userId, t.createdAt),
 index('work_artifacts_conversation').on(t.conversationId),
]);

export const messageFeedback = sqliteTable('message_feedback', {
 messageId: text('message_id').primaryKey().notNull().references(() => messages.id, { onDelete: 'cascade' }),
 userId: text('user_id').notNull(), rating: text('rating').notNull(), details: text('details').notNull().default(''),
 createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, t => [check('message_feedback_rating_check', sql`${t.rating} IN ('up','down')`)]);

export const conversationReports = sqliteTable('conversation_reports', {
 id: text('id').primaryKey().notNull(), userId: text('user_id').notNull(), requestId: text('request_id').notNull(),
 conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
 messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
 category: text('category').notNull(), details: text('details').notNull(), snapshot: text('snapshot').notNull(),
 status: text('status').notNull().default('submitted'), resolution: text('resolution'),
 createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, t => [
 uniqueIndex('conversation_reports_request').on(t.userId, t.requestId), index('conversation_reports_status').on(t.status, t.createdAt),
 check('conversation_reports_category_check', sql`${t.category} IN ('legal','copyright','privacy','illegal','other')`),
 check('conversation_reports_status_check', sql`${t.status} IN ('submitted','reviewing','resolved','dismissed')`),
]);

// The request ledger prevents a repeated click/network retry from charging twice.
// It deliberately has no conversation FK: the idempotency record survives deletion.
export const chatOperations = sqliteTable('chat_operations', {
 id: text('id').primaryKey().notNull(), userId: text('user_id').notNull(), clientRequestId: text('client_request_id').notNull(),
 requestHash: text('request_hash').notNull(), conversationId: text('conversation_id').notNull(),
 action: text('action').notNull(), targetMessageId: text('target_message_id'), userMessageId: text('user_message_id').notNull(),
 assistantMessageId: text('assistant_message_id').notNull(), status: text('status').notNull(), error: text('error'),
 createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, t => [
 uniqueIndex('chat_operations_request').on(t.userId, t.clientRequestId), index('chat_operations_conversation').on(t.conversationId, t.createdAt),
 check('chat_operations_action_check', sql`${t.action} IN ('append','edit','regenerate')`),
 check('chat_operations_status_check', sql`${t.status} IN ('preparing','running','complete','error')`),
]);

// A revision is committed in the same transaction as its replacement. Failed
// generations never touch the user's existing turn or the following messages.
export const conversationRevisions = sqliteTable('conversation_revisions', {
 id: text('id').primaryKey().notNull(), conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
 userId: text('user_id').notNull(), action: text('action').notNull(), targetMessageId: text('target_message_id').notNull(),
 createdAt: integer('created_at').notNull(),
}, t => [index('conversation_revisions_conversation').on(t.conversationId, t.createdAt)]);

export const conversationRevisionMessages = sqliteTable('conversation_revision_messages', {
 revisionId: text('revision_id').notNull().references(() => conversationRevisions.id, { onDelete: 'cascade' }),
 messageId: text('message_id').notNull(), originalOrder: integer('original_order').notNull(), role: text('role').notNull(),
 content: text('content').notNull(), model: text('model'), usageId: text('usage_id').references(() => usage.id, { onDelete: 'set null' }),
 createdAt: integer('created_at').notNull(),
}, t => [primaryKey({ columns: [t.revisionId, t.messageId] })]);

export const securityEventWindows = sqliteTable('security_event_windows', {
 key: text('key').primaryKey().notNull(), category: text('category').notNull(), route: text('route').notNull(),
 eventCount: integer('event_count').notNull(), windowStart: integer('window_start').notNull(), lastSeen: integer('last_seen').notNull(),
 lastRequestId: text('last_request_id').notNull(), lastStatus: integer('last_status').notNull(),
}, t => [index('security_event_windows_time').on(t.windowStart)]);
export const securityAlerts = sqliteTable('security_alerts', {
 id: text('id').primaryKey().notNull(), category: text('category').notNull(), route: text('route').notNull(), severity: text('severity').notNull(),
 eventCount: integer('event_count').notNull(), firstSeen: integer('first_seen').notNull(), lastSeen: integer('last_seen').notNull(),
 lastRequestId: text('last_request_id').notNull(), lastStatus: integer('last_status').notNull(), state: text('state').notNull().default('open'),
 acknowledgedAt: integer('acknowledged_at'),
}, t => [index('security_alerts_time').on(t.lastSeen), check('security_alerts_state_check', sql`${t.state} IN ('open','acknowledged')`), check('security_alerts_severity_check', sql`${t.severity} IN ('warning','high')`)]);

export const accountDeletionJobs = sqliteTable('account_deletion_jobs', {
 id: text('id').primaryKey().notNull(), userId: text('user_id').notNull(), status: text('status').notNull().default('pending'),
 phase: text('phase').notNull().default('waiting'), requestedAt: integer('requested_at').notNull(), updatedAt: integer('updated_at').notNull(),
 completedAt: integer('completed_at'), deletedObjects: integer('deleted_objects').notNull().default(0), attempts: integer('attempts').notNull().default(0),
 lastErrorCode: text('last_error_code'), workerToken: text('worker_token'), workerStartedAt: integer('worker_started_at'),
}, t => [uniqueIndex('account_deletion_pending_owner').on(t.userId).where(sql`${t.status}='pending'`),
 index('account_deletion_owner').on(t.userId,t.requestedAt), index('account_deletion_pending_work').on(t.status,t.updatedAt),
 check('account_deletion_jobs_status_check', sql`${t.status} IN ('pending','complete')`),
 check('account_deletion_jobs_phase_check', sql`${t.phase} IN ('waiting','objects','records','complete')`),
 check('account_deletion_jobs_count_check', sql`${t.deletedObjects}>=0`), check('account_deletion_jobs_attempts_check', sql`${t.attempts}>=0`)]);
export const accountDeletionObjects = sqliteTable('account_deletion_objects', {
 jobId: text('job_id').notNull().references(()=>accountDeletionJobs.id,{onDelete:'cascade'}), objectKey: text('object_key').notNull(),
 state: text('state').notNull().default('pending'), attempts: integer('attempts').notNull().default(0), updatedAt: integer('updated_at').notNull(),
}, t => [primaryKey({columns:[t.jobId,t.objectKey]}), index('account_deletion_objects_pending').on(t.jobId,t.state),
 check('account_deletion_objects_state_check', sql`${t.state} IN ('pending','done')`), check('account_deletion_objects_attempts_check', sql`${t.attempts}>=0`)]);
export const accountDataOperations = sqliteTable('account_data_operations', {
 token: text('token').primaryKey().notNull(), userId: text('user_id').notNull(), startedAt: integer('started_at').notNull(),
}, t => [index('account_data_operations_owner').on(t.userId,t.startedAt)]);
