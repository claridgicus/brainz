-- Idempotent consent (SPEC-CLOUD.md "Authorization"): one authorization code
-- per authorize request. `request_key` is SHA-256 of (user, client, redirect,
-- PKCE challenge, state), unique, so a duplicate Approve (a double click) gets
-- the same code back instead of a second one. The code is HMAC(secret,
-- code_nonce); only its SHA-256 is stored, as before. Codes minted before
-- this migration keep NULL in both (no conflicts; they expire in 5 minutes).
ALTER TABLE `oauth_code` ADD `request_key` text;--> statement-breakpoint
ALTER TABLE `oauth_code` ADD `code_nonce` text;--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_code_request_key` ON `oauth_code` (`request_key`);