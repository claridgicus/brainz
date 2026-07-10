-- Passwordless magic-link auth (Wave A).
-- Retire the account-claim machinery: sign-in/handoff is now a magic link, not
-- a set-password claim page. Add the D1-backed magic-link rate-limit table.
DROP TABLE `account_claims`;
--> statement-breakpoint
CREATE TABLE `magic_link_events` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`ip` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `magic_link_events_email_created_at` ON `magic_link_events` (`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `magic_link_events_ip_created_at` ON `magic_link_events` (`ip`,`created_at`);
