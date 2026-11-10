CREATE TABLE `account_data_operations` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_data_operations_owner` ON `account_data_operations` (`user_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `account_deletion_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`phase` text DEFAULT 'waiting' NOT NULL,
	`requested_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`deleted_objects` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`worker_token` text,
	`worker_started_at` integer,
	CONSTRAINT "account_deletion_jobs_status_check" CHECK("account_deletion_jobs"."status" IN ('pending','complete')),
	CONSTRAINT "account_deletion_jobs_phase_check" CHECK("account_deletion_jobs"."phase" IN ('waiting','objects','records','complete')),
	CONSTRAINT "account_deletion_jobs_count_check" CHECK("account_deletion_jobs"."deleted_objects">=0),
	CONSTRAINT "account_deletion_jobs_attempts_check" CHECK("account_deletion_jobs"."attempts">=0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_deletion_pending_owner` ON `account_deletion_jobs` (`user_id`) WHERE "account_deletion_jobs"."status"='pending';--> statement-breakpoint
CREATE INDEX `account_deletion_owner` ON `account_deletion_jobs` (`user_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `account_deletion_pending_work` ON `account_deletion_jobs` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `account_deletion_objects` (
	`job_id` text NOT NULL,
	`object_key` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`job_id`, `object_key`),
	FOREIGN KEY (`job_id`) REFERENCES `account_deletion_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_deletion_objects_state_check" CHECK("account_deletion_objects"."state" IN ('pending','done')),
	CONSTRAINT "account_deletion_objects_attempts_check" CHECK("account_deletion_objects"."attempts">=0)
);
--> statement-breakpoint
CREATE INDEX `account_deletion_objects_pending` ON `account_deletion_objects` (`job_id`,`state`);
--> statement-breakpoint
-- Tokens deliberately have no expiry. Removing a token solely because it is old
-- would allow a paused request to write into an already-deleted workspace.
CREATE TRIGGER account_operation_deletion_barrier BEFORE INSERT ON account_data_operations
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=NEW.user_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER conversations_deletion_insert BEFORE INSERT ON conversations
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=NEW.user_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER conversations_deletion_update BEFORE UPDATE ON conversations
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE (user_id=NEW.user_id OR user_id=OLD.user_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER files_deletion_insert BEFORE INSERT ON files
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=NEW.user_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER files_deletion_update BEFORE UPDATE ON files
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE (user_id=NEW.user_id OR user_id=OLD.user_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER workspace_settings_deletion_insert BEFORE INSERT ON workspace_settings
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=NEW.user_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER workspace_settings_deletion_update BEFORE UPDATE ON workspace_settings
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE (user_id=NEW.user_id OR user_id=OLD.user_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER public_shares_deletion_insert BEFORE INSERT ON public_shares
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=NEW.user_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER public_shares_deletion_update BEFORE UPDATE ON public_shares
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE (user_id=NEW.user_id OR user_id=OLD.user_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER scheduled_tasks_deletion_insert BEFORE INSERT ON scheduled_tasks
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=NEW.user_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER scheduled_tasks_deletion_update BEFORE UPDATE ON scheduled_tasks
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE (user_id=NEW.user_id OR user_id=OLD.user_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER browser_sessions_deletion_insert BEFORE INSERT ON browser_sessions
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=NEW.user_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER browser_sessions_deletion_update BEFORE UPDATE ON browser_sessions
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE (user_id=NEW.user_id OR user_id=OLD.user_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER media_assets_deletion_insert BEFORE INSERT ON media_assets
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=NEW.user_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER media_assets_deletion_update BEFORE UPDATE ON media_assets
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE (user_id=NEW.user_id OR user_id=OLD.user_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER work_artifacts_deletion_insert BEFORE INSERT ON work_artifacts
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=NEW.user_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER work_artifacts_deletion_update BEFORE UPDATE ON work_artifacts
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE (user_id=NEW.user_id OR user_id=OLD.user_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER conversation_reports_deletion_insert BEFORE INSERT ON conversation_reports
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=NEW.user_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER conversation_reports_deletion_update BEFORE UPDATE ON conversation_reports
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE (user_id=NEW.user_id OR user_id=OLD.user_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER chat_operations_deletion_insert BEFORE INSERT ON chat_operations
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=NEW.user_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER chat_operations_deletion_update BEFORE UPDATE ON chat_operations
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE (user_id=NEW.user_id OR user_id=OLD.user_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER conversation_revisions_deletion_insert BEFORE INSERT ON conversation_revisions
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=NEW.user_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER conversation_revisions_deletion_update BEFORE UPDATE ON conversation_revisions
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE (user_id=NEW.user_id OR user_id=OLD.user_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER message_feedback_deletion_insert BEFORE INSERT ON message_feedback
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE user_id=NEW.user_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER message_feedback_deletion_update BEFORE UPDATE ON message_feedback
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE (user_id=NEW.user_id OR user_id=OLD.user_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER messages_deletion_insert BEFORE INSERT ON messages
WHEN EXISTS (SELECT 1 FROM conversations p JOIN account_deletion_jobs d ON d.user_id=p.user_id
 WHERE p.id=NEW.conversation_id AND d.status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER messages_deletion_update BEFORE UPDATE ON messages
WHEN EXISTS (SELECT 1 FROM conversations p JOIN account_deletion_jobs d ON d.user_id=p.user_id
 WHERE (p.id=NEW.conversation_id OR p.id=OLD.conversation_id) AND d.status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER conversation_revision_messages_deletion_insert BEFORE INSERT ON conversation_revision_messages
WHEN EXISTS (SELECT 1 FROM conversation_revisions p JOIN account_deletion_jobs d ON d.user_id=p.user_id
 WHERE p.id=NEW.revision_id AND d.status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint
CREATE TRIGGER conversation_revision_messages_deletion_update BEFORE UPDATE ON conversation_revision_messages
WHEN EXISTS (SELECT 1 FROM conversation_revisions p JOIN account_deletion_jobs d ON d.user_id=p.user_id
 WHERE (p.id=NEW.revision_id OR p.id=OLD.revision_id) AND d.status='pending')
BEGIN SELECT RAISE(ABORT,'ACCOUNT_DELETION_PENDING'); END;
--> statement-breakpoint

