import { describe, expect, it } from "vitest";
import { safeNextPath } from "./nav";

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
