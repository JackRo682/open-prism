CREATE TABLE `account_flags` (
	`user_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `billing_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`amount` integer NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`payment_key` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_payment_key_unique` ON `payments` (`payment_key`);--> statement-breakpoint
CREATE INDEX `payments_owner` ON `payments` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `wallet_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`mode` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`reference` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_events_reference_unique` ON `wallet_events` (`reference`);--> statement-breakpoint
CREATE INDEX `wallet_owner` ON `wallet_events` (`user_id`,`mode`,`created_at`);