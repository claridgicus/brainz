CREATE TABLE `account_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_claims_token_hash_unique` ON `account_claims` (`token_hash`);--> statement-breakpoint
CREATE TABLE `signup_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ip` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `signup_events_ip_created_at` ON `signup_events` (`ip`,`created_at`);