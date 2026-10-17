import { integer, sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
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
