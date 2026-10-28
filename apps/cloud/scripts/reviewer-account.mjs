#!/usr/bin/env node
/**
 * Provision a directory-REVIEWER account (Wave OA, SPEC-CLOUD.md "Reviewer
 * test login"): an email + password login with no email-verification step,
 * which the Anthropic and OpenAI directory reviewers need. Users never get
 * passwords — Better Auth runs email+password with `disableSignUp`, so only
 * accounts written by this script can sign in that way.
 *
 * Writes (idempotently) a permanent `user` row and a `credential` `account`
 * row holding Better Auth's scrypt hash, via `wrangler d1 execute`. Re-running
 * for the same email resets the password.
 *
 * Optional `--seed <origin>` then signs in over HTTP and fills a "Brainz demo"
 * vault from examples/demo-vault through the REST API, so reviewers get a
 * fully populated account.
 *
 * Usage (from apps/cloud):
 *   node scripts/reviewer-account.mjs --directory anthropic --remote [--seed https://brainz.brownmatter.ai]
 *   node scripts/reviewer-account.mjs --email <addr> --local [--persist-to DIR]
 *       [--password P] [--name "Directory Reviewer"]
 *
 * By default the address is UNGUESSABLE and per directory:
 * `review-<directory>-<12 random chars>@brownmatter.ai`. A guessable address
 * (reviewer@…) would let anyone burn its failed-sign-in allowance and lock the
 * reviewer out mid-review. No inbox is needed — reviewers sign in with the
 * password. The password is generated (32 base62 chars) unless --password is
 * given (min 20 chars). Both are printed once; store them in the portal.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "better-auth/crypto";
import { parseNote } from "@brainz/engine";

const appDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEMO_VAULT = path.resolve(appDir, "../../examples/demo-vault/concepts");
const MIN_PASSWORD_LENGTH = 20;

function parseArgs(argv) {
  const out = { local: false, remote: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local") out.local = true;
    else if (a === "--remote") out.remote = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function randomString(length, alphabet) {
  // Rejection sampling keeps every character equally likely.
  const ceiling = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length))) {
      if (b < ceiling && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

const randomPassword = (length = 32) =>
  randomString(length, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");

/** `review-<directory>-<12 random [a-z0-9]>@brownmatter.ai` (~62 bits; unguessable). */
export function reviewerAddress(directory) {
  const slug = String(directory).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("--directory must contain letters or digits");
  return `review-${slug}-${randomString(12, "abcdefghijklmnopqrstuvwxyz0123456789")}@brownmatter.ai`;
}

const sql = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** The idempotent upsert of the user + credential rows. */
export async function reviewerSql({ email, name, password, now = Date.now() }) {
  const userId = crypto.randomUUID();
  const hash = await hashPassword(password);
  return [
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at, expires_at)
       VALUES (${sql(userId)}, ${sql(name)}, ${sql(email)}, 1, ${now}, ${now}, NULL)
       ON CONFLICT(email) DO UPDATE SET expires_at = NULL, updated_at = ${now};`,
    `INSERT INTO account (id, user_id, account_id, provider_id, password, created_at, updated_at)
       SELECT ${sql(crypto.randomUUID())}, id, id, 'credential', ${sql(hash)}, ${now}, ${now} FROM user WHERE email = ${sql(email)}
       ON CONFLICT(user_id, provider_id) DO UPDATE SET password = excluded.password, updated_at = ${now};`,
  ].join("\n");
}

async function seedDemoVault(origin, email, password) {
  const headers = { origin, "content-type": "application/json" };
  const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });
  if (signIn.status !== 200) throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const authed = { ...headers, cookie };

  const list = await (await fetch(`${origin}/api/vaults`, { headers: authed })).json();
  let vault = list.vaults?.find((v) => v.slug === "brainz-demo");
  if (!vault) {
    const res = await fetch(`${origin}/api/vaults`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ name: "Brainz demo", slug: "brainz-demo" }),
    });
    if (res.status !== 201) throw new Error(`create vault failed: ${res.status} ${await res.text()}`);
    vault = await res.json();
  }
  let n = 0;
  for (const file of readdirSync(DEMO_VAULT).filter((f) => f.endsWith(".md")).sort()) {
    const { meta, body, relations } = parseNote(readFileSync(path.join(DEMO_VAULT, file), "utf8"), {
      fallbackId: file.replace(/\.md$/, ""),
    });
    const res = await fetch(`${origin}/api/vaults/${vault.id}/concepts`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({
        id: meta.id,
        title: meta.title,
        body,
        type: meta.type,
        status: meta.status,
        tags: meta.tags,
        ...(meta.product ? { product: meta.product } : {}),
        ...(Object.keys(relations).length ? { relations } : {}),
      }),
    });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`upsert ${meta.id} failed: ${res.status} ${await res.text()}`);
    }
    n++;
  }
  return { vaultId: vault.id, concepts: n };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ((!args.email && !args.directory) || args.local === args.remote) {
    console.error(
      "usage: reviewer-account.mjs (--directory <anthropic|openai|...> | --email <addr>) (--local | --remote) [--persist-to DIR] [--password P] [--name N] [--seed ORIGIN]",
    );
    process.exit(2);
  }
  const email = (args.email ?? reviewerAddress(args.directory)).trim().toLowerCase();
  const password = args.password ?? randomPassword();
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    process.exit(2);
  }
  const statements = await reviewerSql({ email, name: args.name ?? "Directory Reviewer", password });
  const wrangler = ["wrangler", "d1", "execute", "brainz", args.remote ? "--remote" : "--local"];
  if (args["persist-to"]) wrangler.push("--persist-to", args["persist-to"]);
  wrangler.push("--command", statements);
  const res = spawnSync("npx", wrangler, { cwd: appDir, encoding: "utf8" });
  if (res.status !== 0) {
    console.error(res.stdout, res.stderr);
    process.exit(1);
  }
  console.log(`reviewer account ready: ${email}${args.email ? "" : " (generated — store it with the password)"}`);
  if (!args.password) console.log(`password (shown once): ${password}`);
  if (args.seed) {
    const seeded = await seedDemoVault(args.seed.replace(/\/+$/, ""), email, password);
    console.log(`seeded vault ${seeded.vaultId} with ${seeded.concepts} concepts`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
