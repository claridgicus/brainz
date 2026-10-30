/**
 * What a demo depends on, reduced to one hash.
 *
 * A demo shows a handful of screens; when any file behind those screens
 * changes, the clip is stale and must be re-recorded. The manifest names the
 * screens' sources as globs, every demo also depends on the recorder itself,
 * the seed its demo account is filled from and the dashboard's shared chrome, and the
 * fingerprint is a sha256 over the sorted `<path> <blob>` lines of every
 * matching file — `blob` being git's own object id for the content, so the
 * hash of a recording made from the working tree equals the hash
 * `demos:check` computes from the index (or CI from a commit) whenever the two agree.
 */
import { createHash } from "node:crypto";

/** Sources every demo shows, whatever screen it is on. */
export const IMPLICIT_DEPENDENCIES: ReadonlyArray<string> = [
  "demos/src/**",
  "compose.yaml",
  // The sample product every demo account is filled with (tenant.ts).
  "examples/demo-vault/concepts/**",
  "docs/submissions/seed-reviewer-vault.mjs",
  // The dashboard's shared chrome.
  "apps/cloud/src/app.css",
  "apps/cloud/src/app.html",
  "apps/cloud/src/routes/+layout.svelte",
  "apps/cloud/src/routes/(app)/+layout.svelte",
  "apps/cloud/src/lib/components/**",
];

/** A tracked file as the index (or the working tree) knows it. */
export interface Blob {
  readonly path: string;
  /** git's object id for the content: sha1 over `blob <length>\0<bytes>`. */
  readonly oid: string;
}

/**
 * The object id git gives `content` — so a working-tree file and its staged
 * copy hash alike, and `git ls-files -s` can answer for the whole index
 * without reading a byte.
 */
export const gitBlobOid = (content: Uint8Array): string =>
  createHash("sha1")
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest("hex");

/**
 * A glob as the manifest writes it: `**` spans directories, `*` a name,
 * anchored at the repository root. Tests, being sources the screen is not
 * made of, are excluded — a test edit never stales a clip.
 */
export const globToRegExp = (glob: string): RegExp => {
  let source = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; a trailing `**` the rest.
        const slash = glob[i + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char !== undefined) {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(source + "$");
};

const isTest = (path: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)test\//.test(path);

/** The files a list of globs names, tests left out, sorted for a stable hash. */
export const matchingBlobs = (
  globs: ReadonlyArray<string>,
  blobs: ReadonlyArray<Blob>,
): ReadonlyArray<Blob> => {
  const patterns = globs.map(globToRegExp);
  return blobs
    .filter((blob) => !isTest(blob.path) && patterns.some((pattern) => pattern.test(blob.path)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

/** The hash a demo's clip is recorded under. */
export const fingerprint = (
  dependencies: ReadonlyArray<string>,
  blobs: ReadonlyArray<Blob>,
): string => {
  const hash = createHash("sha256");
  for (const blob of matchingBlobs([...IMPLICIT_DEPENDENCIES, ...dependencies], blobs)) {
    hash.update(`${blob.path} ${blob.oid}\n`);
  }
  return hash.digest("hex");
};

/** What `demos/fingerprints.json` holds: one entry per recorded demo. */
export interface Recorded {
  readonly hash: string;
  readonly recordedAt: string;
  /** Seconds of clip, for the docs to say how long a watch is. */
  readonly seconds: number;
}

export type Fingerprints = Readonly<Record<string, Recorded>>;

export type Staleness =
  | { readonly kind: "fresh" }
  | { readonly kind: "unrecorded" }
  | { readonly kind: "changed" }
  | { readonly kind: "missing-output"; readonly file: string };

/**
 * Whether a demo's clip still matches its sources: never recorded, recorded
 * against other sources, or recorded but the files it should have produced
 * are not there (a clip deleted from static/ is as stale as one never made).
 */
export const staleness = (
  id: string,
  hash: string,
  recorded: Fingerprints,
  outputs: ReadonlyArray<string>,
  exists: (file: string) => boolean,
): Staleness => {
  const entry = recorded[id];
  if (entry === undefined) return { kind: "unrecorded" };
  if (entry.hash !== hash) return { kind: "changed" };
  const missing = outputs.find((file) => !exists(file));
  return missing === undefined ? { kind: "fresh" } : { kind: "missing-output", file: missing };
};

/**
 * A `git ls-tree -r <rev>` listing, parsed: `<mode> <type> <oid>\t<path>` per
 * line, blobs only (a submodule's commit is not a source).
 */
export const parseTreeListing = (listing: string): ReadonlyArray<Blob> =>
  listing
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const tab = line.indexOf("\t");
      const [, type, oid] = line.slice(0, tab).split(" ");
      return oid === undefined || tab < 0 || type !== "blob" ? [] : [{ path: line.slice(tab + 1), oid }];
    });

/** A `git ls-files -s` listing, parsed: `<mode> <oid> <stage>\t<path>` per line. */
export const parseIndexListing = (listing: string): ReadonlyArray<Blob> =>
  listing
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const tab = line.indexOf("\t");
      const [, oid] = line.slice(0, tab).split(" ");
      return oid === undefined || tab < 0 ? [] : [{ path: line.slice(tab + 1), oid }];
    });
