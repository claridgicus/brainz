CREATE TABLE `oauth_register_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ip` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_register_events_ip_created_at` ON `oauth_register_events` (`ip`,`created_at`);--> statement-breakpoint
ALTER TABLE `oauth_code` ADD `redirect_uri_explicit` integer DEFAULT true NOT NULL;