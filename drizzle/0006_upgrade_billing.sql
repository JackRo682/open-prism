-- Additive billing migration. Existing 0004/0005 tables are already deployed;
-- the generated 0006 snapshot also catches up their missing historical metadata.
CREATE TABLE `payment_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`request_id` text NOT NULL,
	`amount` integer NOT NULL,
	`baseline_refunded` integer NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`provider_cancel_key` text,
	`submitted_at` integer,
	`completed_at` integer,
	`last_error` text,
	`lock_token` text,
	`locked_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_refunds_amount_check" CHECK("payment_refunds"."amount" > 0 AND "payment_refunds"."baseline_refunded" >= 0),
	CONSTRAINT "payment_refunds_status_check" CHECK("payment_refunds"."status" IN ('pending','succeeded','failed','review'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_refunds_request_id_unique` ON `payment_refunds` (`request_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_refunds_idempotency_key_unique` ON `payment_refunds` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `payment_refunds_payment` ON `payment_refunds` (`payment_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `payments` ADD `candidate_payment_key` text;
--> statement-breakpoint
ALTER TABLE `payments` ADD `product_id` text;
--> statement-breakpoint
ALTER TABLE `payments` ADD `order_name` text;
--> statement-breakpoint
ALTER TABLE `payments` ADD `product_snapshot` text;
--> statement-breakpoint
ALTER TABLE `payments` ADD `checkout_request_id` text;
--> statement-breakpoint
ALTER TABLE `payments` ADD `currency` text DEFAULT 'KRW' NOT NULL;
--> statement-breakpoint
ALTER TABLE `payments` ADD `terms_version` text;
--> statement-breakpoint
ALTER TABLE `payments` ADD `terms_hash` text;
--> statement-breakpoint
ALTER TABLE `payments` ADD `consent_snapshot` text;
--> statement-breakpoint
ALTER TABLE `payments` ADD `consented_at` integer;
--> statement-breakpoint
ALTER TABLE `payments` ADD `refunded_amount` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `payments` ADD `paid_at` integer;
--> statement-breakpoint
ALTER TABLE `payments` ADD `expires_at` integer;
--> statement-breakpoint
ALTER TABLE `payments` ADD `updated_at` integer;
--> statement-breakpoint
ALTER TABLE `payments` ADD `last_error` text;
--> statement-breakpoint
ALTER TABLE `payments` ADD `provider_status` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_checkout_request` ON `payments` (`user_id`,`mode`,`checkout_request_id`);
