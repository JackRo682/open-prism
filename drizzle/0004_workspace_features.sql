CREATE TABLE IF NOT EXISTS `scheduled_tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `title` text NOT NULL,
  `prompt` text NOT NULL,
  `model` text NOT NULL,
  `timezone` text NOT NULL,
  `recurrence` text NOT NULL CHECK (`recurrence` IN ('once','daily','weekly')),
  `scheduled_at` integer NOT NULL,
  `next_run` integer,
  `last_run` integer,
  `last_error` text,
  `last_conversation_id` text,
  `enabled` integer NOT NULL DEFAULT 0 CHECK (`enabled` IN (0,1)),
  `status` text NOT NULL DEFAULT 'draft' CHECK (`status` IN ('draft','active','paused','running','completed','error')),
  `run_token` text,
  `locked_until` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scheduled_tasks_owner` ON `scheduled_tasks` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scheduled_tasks_due` ON `scheduled_tasks` (`enabled`,`next_run`);
