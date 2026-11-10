-- Additive conversation actions; existing chats and accounting records are preserved.
CREATE TABLE `chat_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`conversation_id` text NOT NULL,
	`action` text NOT NULL,
	`target_message_id` text,
	`user_message_id` text NOT NULL,
	`assistant_message_id` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chat_operations_action_check" CHECK("chat_operations"."action" IN ('append','edit','regenerate')),
	CONSTRAINT "chat_operations_status_check" CHECK("chat_operations"."status" IN ('preparing','running','complete','error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_operations_request` ON `chat_operations` (`user_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `chat_operations_conversation` ON `chat_operations` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `conversation_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`conversation_id` text,
	`message_id` text,
	`category` text NOT NULL,
	`details` text NOT NULL,
	`snapshot` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`resolution` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "conversation_reports_category_check" CHECK("conversation_reports"."category" IN ('legal','copyright','privacy','illegal','other')),
	CONSTRAINT "conversation_reports_status_check" CHECK("conversation_reports"."status" IN ('submitted','reviewing','resolved','dismissed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_reports_request` ON `conversation_reports` (`user_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `conversation_reports_status` ON `conversation_reports` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `conversation_revision_messages` (
	`revision_id` text NOT NULL,
	`message_id` text NOT NULL,
	`original_order` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`model` text,
	`usage_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`revision_id`, `message_id`),
	FOREIGN KEY (`revision_id`) REFERENCES `conversation_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`usage_id`) REFERENCES `usage`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `conversation_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`target_message_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_revisions_conversation` ON `conversation_revisions` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `message_feedback` (
	`message_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`rating` text NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_feedback_rating_check" CHECK("message_feedback"."rating" IN ('up','down'))
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `pinned_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `usage_id` text REFERENCES usage(id) ON DELETE SET NULL;
