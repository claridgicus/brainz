import { describe, expect, it } from "vitest";
import { safeNextPath, vaultTabLinks } from "./nav";

describe("safeNextPath", () => {
  it("accepts same-origin relative paths", () => {
    expect(safeNextPath("/v/acme/settings")).toBe("/v/acme/settings");
  });
  it("falls back for missing or absolute/protocol-relative targets", () => {
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath("https://evil.example")).toBe("/dashboard");
    expect(safeNextPath("//evil.example")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.example")).toBe("/dashboard");
  });
});

describe("vaultTabLinks", () => {
  it("links every other workspace view, Features next to Board and Burndown", () => {
    expect(vaultTabLinks("acme", "graph")).toEqual([
      { href: "/v/acme/board", label: "Board" },
      { href: "/v/acme/features", label: "Features" },
      { href: "/v/acme/burndown", label: "Burndown" },
    ]);
    expect(vaultTabLinks("acme", "features").map((l) => l.label)).toEqual(["Graph", "Board", "Burndown"]);
  });
});
