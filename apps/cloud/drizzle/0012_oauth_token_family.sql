ALTER TABLE `oauth_client` ADD `last_used_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_token` ADD `parent_hash` text;--> statement-breakpoint
ALTER TABLE `oauth_token` ADD `revoked_at` integer;--> statement-breakpoint
CREATE INDEX `oauth_token_parent_hash` ON `oauth_token` (`parent_hash`);