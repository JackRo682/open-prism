ALTER TABLE `usage` ADD `rate_snapshot` text;--> statement-breakpoint
ALTER TABLE `usage` ADD `reserved_amount` integer DEFAULT 0 NOT NULL;