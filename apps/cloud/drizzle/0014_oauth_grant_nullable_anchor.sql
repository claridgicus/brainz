-- Multi-vault grants (SPEC-CLOUD.md "Multi-vault grants"): oauth_grant.vault_id
-- becomes nullable with ON DELETE SET NULL, so an "all my vaults" grant
-- outlives the user's last vault. SQLite can't ALTER a column's NOT NULL or
-- FK, so the table is rebuilt. Every other column, the user_id FK (ON DELETE
-- cascade) and the oauth_grant_user_id index are unchanged.
--
-- PRESERVES EVERY ROW. Dropping the old oauth_grant fires its children's
-- ON DELETE CASCADE (oauth_token, oauth_grant_vault) even with FK checks
-- deferred, and D1 runs a migration inside a transaction where
-- `PRAGMA foreign_keys=OFF` is a no-op. So the children are copied aside
-- first and restored after the rename. oauth_code has no FK to oauth_grant
-- and is untouched. One migration file = one atomic D1 apply: on any error
-- nothing changes. No BEGIN/COMMIT (D1 rejects explicit transactions).
-- Row-count check before/after: apps/cloud/README.md "Migration 0014".
CREATE TABLE `__bk_oauth_token` AS SELECT `token_hash`, `grant_id`, `kind`, `created_at`, `expires_at`, `used_at`, `parent_hash`, `revoked_at` FROM `oauth_token`;--> statement-breakpoint
CREATE TABLE `__bk_oauth_grant_vault` AS SELECT `grant_id`, `vault_id` FROM `oauth_grant_vault`;--> statement-breakpoint
CREATE TABLE `__new_oauth_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`vault_id` text,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`vault_scope` text DEFAULT 'single' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vault_id`) REFERENCES `vault`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_oauth_grant`("id", "client_id", "user_id", "vault_id", "scope", "created_at", "revoked_at", "vault_scope") SELECT "id", "client_id", "user_id", "vault_id", "scope", "created_at", "revoked_at", "vault_scope" FROM `oauth_grant`;--> statement-breakpoint
DROP TABLE `oauth_grant`;--> statement-breakpoint
ALTER TABLE `__new_oauth_grant` RENAME TO `oauth_grant`;--> statement-breakpoint
CREATE INDEX `oauth_grant_user_id` ON `oauth_grant` (`user_id`);--> statement-breakpoint
INSERT INTO `oauth_token` (`token_hash`, `grant_id`, `kind`, `created_at`, `expires_at`, `used_at`, `parent_hash`, `revoked_at`) SELECT `token_hash`, `grant_id`, `kind`, `created_at`, `expires_at`, `used_at`, `parent_hash`, `revoked_at` FROM `__bk_oauth_token`;--> statement-breakpoint
INSERT INTO `oauth_grant_vault` (`grant_id`, `vault_id`) SELECT `grant_id`, `vault_id` FROM `__bk_oauth_grant_vault`;--> statement-breakpoint
DROP TABLE `__bk_oauth_token`;--> statement-breakpoint
DROP TABLE `__bk_oauth_grant_vault`;
