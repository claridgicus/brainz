CREATE TABLE `account_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`approved_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_claims_token_hash_unique` ON `account_claims` (`token_hash`);--> statement-breakpoint
CREATE INDEX `account_claims_user_id` ON `account_claims` (`user_id`);--> statement-breakpoint
CREATE INDEX `account_claims_email` ON `account_claims` (`email`);--> statement-breakpoint
ALTER TABLE `user` ADD `expires_at` integer;