import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, index, check, primaryKey } from 'drizzle-orm/sqlite-core';
export const conversations = sqliteTable('conversations', {
 id: text('id').primaryKey(), userId: text('user_id').notNull(), title: text('title').notNull(), model: text('model').notNull(),
 createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, t => [index('conversations_owner').on(t.userId, t.updatedAt)]);
export const messages = sqliteTable('messages', {
 id: text('id').primaryKey(), conversationId: text('conversation_id').notNull().references(()=>conversations.id,{onDelete:'cascade'}),
 role: text('role').notNull(), content: text('content').notNull(), model: text('model'), createdAt: integer('created_at').notNull(),
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
 key: text('key').primaryKey(), count: integer('count').notNull(), expiresAt: integer('expires_at').notNull(),
});
export const walletEvents = sqliteTable('wallet_events', {
 id:text('id').primaryKey(),userId:text('user_id').notNull(),mode:text('mode').notNull(),kind:text('kind').notNull(),
 amount:integer('amount').notNull(),reference:text('reference').notNull().unique(),createdAt:integer('created_at').notNull(),
},t=>[index('wallet_owner').on(t.userId,t.mode,t.createdAt)]);
export const payments = sqliteTable('payments', {
 id:text('id').primaryKey(),userId:text('user_id').notNull(),amount:integer('amount').notNull(),mode:text('mode').notNull(),
 status:text('status').notNull(),paymentKey:text('payment_key').unique(),createdAt:integer('created_at').notNull(),
},t=>[index('payments_owner').on(t.userId,t.createdAt)]);
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
