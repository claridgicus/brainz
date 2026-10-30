-- Support inbox (SPEC-CLOUD.md "Support inbox"): one row per inbound message,
-- outbound reply and agent draft on support@brownmatter.ai. message_id threads
-- replies onto task_id (a task in the support vault).
CREATE TABLE `support_message` (
	`id` text PRIMARY KEY NOT NULL,
	`direction` text NOT NULL,
	`message_id` text,
	`task_id` text,
	`from_addr` text NOT NULL,
	`to_addr` text NOT NULL,
	`reply_to` text,
	`subject` text DEFAULT '' NOT NULL,
	`category` text,
	`disposition` text NOT NULL,
	`note` text,
	`auth_json` text,
	`attachments_json` text DEFAULT '[]' NOT NULL,
	`raw_key` text,
	`raw_b64` text,
	`body_text` text,
	`actor` text,
	`size` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `support_message_message_id` ON `support_message` (`message_id`);--> statement-breakpoint
CREATE INDEX `support_message_task_id` ON `support_message` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `support_message_from_created_at` ON `support_message` (`from_addr`,`created_at`);--> statement-breakpoint
CREATE INDEX `support_message_direction_created_at` ON `support_message` (`direction`,`created_at`);