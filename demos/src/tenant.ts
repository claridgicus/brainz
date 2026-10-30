/**
 * The demo account: a fresh Brainz account for every take, signed up the
 * way a person signs up (a magic link, captured from the stack's mailer) and
 * filled with the sample product reviewers see — never anyone's real data.
 *
 * The stack starts empty on every run (`stack.ts`), so a demo's persona
 * (its name and email, declared in the manifest) is new each time and the
 * clip shows the same account, the same vaults and the same graph whenever
 * it is recorded. What it is filled with is what the directory reviewers
 * get: the examples/demo-vault concepts in a "Brainz demo" vault (as
 * apps/cloud/scripts/reviewer-account.mjs `--seed` writes them), topped up
 * with docs/submissions/seed-reviewer-vault.mjs's Acme CRM concepts and
 * task pile.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logs, readInStack, root } from "./stack.js";

export interface Persona {
  readonly name: string;
  readonly email: string;
}

/** A cookie as the browser context takes it. */
export interface SessionCookie {
  readonly name: string;
  readonly value: string;
}

export interface Vault {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** What `seed` leaves in `<dir>/tenant.json` for the take. */
export interface DemoTenant {
  readonly persona: Persona;
  readonly cookies: ReadonlyArray<SessionCookie>;
  /** The vaults the account was given, the seeded "Brainz demo" first. */
  readonly vaults: ReadonlyArray<Vault>;
}

/** The vault every demo account owns, seeded with the reviewer sample product. */
export const DEMO_VAULT = { name: "Brainz demo", slug: "brainz-demo" } as const;

/** The magic-link verify path in a captured email, wherever the link says it is hosted. */
export const verifyPathIn = (email: string): string | undefined =>
  /\/api\/auth\/magic-link\/verify\?[^\s"'<>)]+/.exec(email)?.[0]?.replaceAll("&amp;", "&");

/** The `.eml` files miniflare's send_email stub logged, oldest first. */
export const emlPathsIn = (log: string): ReadonlyArray<string> =>
  [...log.matchAll(/send_email binding called[^\n]*\n\s*(\S+\.eml)/g)].map((match) => match[1]!);

const cookiesOf = (response: Response): SessionCookie[] =>
  response.headers.getSetCookie().flatMap((raw) => {
    const [pair = ""] = raw.split(";");
    const eq = pair.indexOf("=");
    return eq > 0 ? [{ name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() }] : [];
  });

/** A JSON client on the app as one signed-in account, failing loudly on anything but success. */
export const client = (origin: string, cookies: ReadonlyArray<SessionCookie>) => {
  const headers = {
    origin,
    "content-type": "application/json",
    cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
  };
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
    return (text === "" ? undefined : JSON.parse(text)) as T;
  };
  return {
    get: <T>(path: string) => call<T>("GET", path),
    post: <T>(path: string, body?: unknown) => call<T>("POST", path, body),
    patch: <T>(path: string, body?: unknown) => call<T>("PATCH", path, body),
  };
};

export type Client = ReturnType<typeof client>;

/**
 * Sign the persona up: ask for a magic link (a new email makes a new
 * account), read it from the email the stack's mailer stub wrote, follow it,
 * and keep the session cookie it sets.
 */
export const signUp = async (origin: string, persona: Persona): Promise<SessionCookie[]> => {
  const seen = new Set(emlPathsIn(logs()));
  const asked = await fetch(`${origin}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: persona.email, name: persona.name, callbackURL: "/dashboard" }),
  });
  if (!asked.ok) throw new Error(`magic-link request failed (${asked.status}): ${await asked.text()}`);
  let verify: string | undefined;
  const deadline = Date.now() + 15_000;
  while (verify === undefined && Date.now() < deadline) {
    for (const path of emlPathsIn(logs()).filter((p) => !seen.has(p))) {
      const email = readInStack(path);
      if (email.includes(`<${persona.email}>`)) verify = verifyPathIn(email);
    }
    if (verify === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (verify === undefined) throw new Error(`no magic link for ${persona.email} reached the stack's mailer`);
  const followed = await fetch(`${origin}${verify}`, { redirect: "manual", headers: { origin } });
  const cookies = cookiesOf(followed);
  if (cookies.length === 0) throw new Error(`following the magic link set no cookie (${followed.status})`);
  return cookies;
};

/** A concept as the REST upsert takes it. */
type ConceptInput = Record<string, unknown> & { readonly id: string };

/** The examples/demo-vault concepts, parsed the way reviewer-account.mjs `--seed` does. */
const demoVaultConcepts = async (): Promise<ConceptInput[]> => {
  // Loaded by name, not by a static import: engine's types come from its build,
  // and the demos typecheck should not need one.
  const engine = "@brainz/engine";
  const { parseNote } = (await import(engine)) as {
    parseNote: (
      text: string,
      options: { fallbackId: string },
    ) => { meta: Record<string, unknown> & { id: string }; body: string; relations: Record<string, unknown> };
  };
  const dir = join(root, "examples/demo-vault/concepts");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const { meta, body, relations } = parseNote(readFileSync(join(dir, file), "utf8"), {
        fallbackId: file.replace(/\.md$/, ""),
      });
      return {
        id: meta.id,
        title: meta.title,
        body,
        type: meta.type,
        status: meta.status,
        tags: meta.tags,
        ...(meta.product ? { product: meta.product } : {}),
        ...(Object.keys(relations).length > 0 ? { relations } : {}),
      };
    });
};

/** The reviewer top-up: seed-reviewer-vault.mjs's SEED, under its product. */
const reviewerConcepts = async (): Promise<ConceptInput[]> => {
  const script = join(root, "docs/submissions/seed-reviewer-vault.mjs");
  const { SEED } = (await import(script)) as { SEED: ReadonlyArray<ConceptInput> };
  return SEED.map((concept) => ({ product: "acme-crm", status: "active", ...concept }));
};

/** Upsert concepts into a vault, in order. */
export const upsertConcepts = async (api: Client, vaultId: string, concepts: ReadonlyArray<ConceptInput>) => {
  for (const concept of concepts) await api.post(`/api/vaults/${vaultId}/concepts`, concept);
};

/**
 * A freshly signed-up demo account with the seeded "Brainz demo" vault and,
 * should the demo want them, more vaults (empty) beside it.
 */
export const demoTenant = async (
  origin: string,
  persona: Persona,
  extraVaults: ReadonlyArray<{ readonly name: string; readonly slug: string }> = [],
): Promise<DemoTenant> => {
  const cookies = await signUp(origin, persona);
  const api = client(origin, cookies);
  const vaults: Vault[] = [];
  for (const wanted of [DEMO_VAULT, ...extraVaults]) {
    vaults.push(await api.post<Vault>("/api/vaults", wanted));
  }
  const demo = vaults[0]!;
  await upsertConcepts(api, demo.id, await demoVaultConcepts());
  await upsertConcepts(api, demo.id, await reviewerConcepts());
  return { persona, cookies, vaults };
};
