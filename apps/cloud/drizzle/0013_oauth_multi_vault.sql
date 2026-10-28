CREATE TABLE `oauth_grant_vault` (
	`grant_id` text NOT NULL,
	`vault_id` text NOT NULL,
	PRIMARY KEY(`grant_id`, `vault_id`),
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vault_id`) REFERENCES `vault`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_grant_vault_vault_id` ON `oauth_grant_vault` (`vault_id`);--> statement-breakpoint
ALTER TABLE `oauth_code` ADD `vault_scope` text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_code` ADD `vault_ids` text;--> statement-breakpoint
ALTER TABLE `oauth_grant` ADD `vault_scope` text DEFAULT 'single' NOT NULL;--> statement-breakpoint
-- Every existing grant is a "single" grant over its vault_id: give it its join row.
INSERT INTO `oauth_grant_vault` (`grant_id`, `vault_id`) SELECT `id`, `vault_id` FROM `oauth_grant`;