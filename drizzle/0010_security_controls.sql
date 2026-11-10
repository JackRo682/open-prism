CREATE TABLE `security_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`route` text NOT NULL,
	`severity` text NOT NULL,
	`event_count` integer NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`last_request_id` text NOT NULL,
	`last_status` integer NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`acknowledged_at` integer,
	CONSTRAINT "security_alerts_state_check" CHECK("security_alerts"."state" IN ('open','acknowledged')),
	CONSTRAINT "security_alerts_severity_check" CHECK("security_alerts"."severity" IN ('warning','high'))
);
--> statement-breakpoint
CREATE INDEX `security_alerts_time` ON `security_alerts` (`last_seen`);--> statement-breakpoint
CREATE TABLE `security_event_windows` (
	`key` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`route` text NOT NULL,
	`event_count` integer NOT NULL,
	`window_start` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`last_request_id` text NOT NULL,
	`last_status` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `security_event_windows_time` ON `security_event_windows` (`window_start`);--> statement-breakpoint
ALTER TABLE `rate_limits` ADD `lease_token` text;