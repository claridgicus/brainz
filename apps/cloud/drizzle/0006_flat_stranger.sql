CREATE TABLE `vault_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	FOREIGN KEY (`vault_id`) REFERENCES `vault`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_invite_token_hash_unique` ON `vault_invite` (`token_hash`);--> statement-breakpoint
CREATE INDEX `vault_invite_vault_id` ON `vault_invite` (`vault_id`);--> statement-breakpoint
CREATE INDEX `vault_invite_email` ON `vault_invite` (`email`);--> statement-breakpoint
CREATE TABLE `vault_member` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`vault_id`) REFERENCES `vault`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_member_vault_id_user_id_unique` ON `vault_member` (`vault_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `vault_member_user_id` ON `vault_member` (`user_id`);--> statement-breakpoint
INSERT INTO `vault_member` (`id`, `vault_id`, `user_id`, `role`, `created_at`)
SELECT v.`id` || '-owner', v.`id`, v.`owner_id`, 'owner', v.`created_at`
FROM `vault` v
WHERE NOT EXISTS (
  SELECT 1 FROM `vault_member` m WHERE m.`vault_id` = v.`id` AND m.`user_id` = v.`owner_id`
);