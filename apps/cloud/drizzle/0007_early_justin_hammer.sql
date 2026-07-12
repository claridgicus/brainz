CREATE TABLE `public_read_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ip` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `public_read_events_ip_created_at` ON `public_read_events` (`ip`,`created_at`);--> statement-breakpoint
ALTER TABLE `vault` ADD `public_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `vault` ADD `public_token_hash` text;--> statement-breakpoint
ALTER TABLE `vault` ADD `public_created_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `vault_public_token_hash_unique` ON `vault` (`public_token_hash`);