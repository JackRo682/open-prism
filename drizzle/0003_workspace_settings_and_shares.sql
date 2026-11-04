CREATE TABLE IF NOT EXISTS `public_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`token` text NOT NULL,
	`title` text NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `public_shares_token_unique` ON `public_shares` (`token`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `public_shares_owner` ON `public_shares` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workspace_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`updated_at` integer NOT NULL
);
