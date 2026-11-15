/** Sanitize a ?next= redirect target: same-origin relative paths only. */
export function safeNextPath(raw: string | null, fallback = "/dashboard"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}

/** The vault workspace's views, in toolbar order. */
export const VAULT_TABS = [
  { id: "graph", label: "Graph", path: "" },
  { id: "board", label: "Board", path: "/board" },
  { id: "features", label: "Features", path: "/features" },
  { id: "burndown", label: "Burndown", path: "/burndown" },
] as const;
export type VaultTab = (typeof VAULT_TABS)[number]["id"];

/** Toolbar links from one workspace view to the others (the current one is left out). */
export function vaultTabLinks(slug: string, current: VaultTab): { href: string; label: string }[] {
  return VAULT_TABS.filter((t) => t.id !== current).map((t) => ({
    href: `/v/${slug}${t.path}`,
    label: t.label,
  }));
}
