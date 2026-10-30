import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { globToRegExp } from "../src/fingerprint.js";
import { DEMOS, outputsOf } from "../src/manifest.js";
import { root } from "../src/stack.js";

/** Every file under `dir`, relative to the repository root. */
const walk = (dir: string): string[] =>
  readdirSync(`${root}/${dir}`, { withFileTypes: true }).flatMap((entry) =>
    entry.name === "node_modules" || entry.name.startsWith(".")
      ? []
      : entry.isDirectory()
        ? walk(`${dir}/${entry.name}`)
        : [`${dir}/${entry.name}`],
  );

describe("the demo manifest", () => {
  it("names the three first demos, each once, with a file-safe id", () => {
    const ids = DEMOS.map((demo) => demo.id);
    expect(ids).toEqual(expect.arrayContaining(["consent-and-connect", "dashboard-graph", "openai-review"]));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("gives every demo a persona of its own: one run signs them all up on one stack", () => {
    const emails = DEMOS.map((demo) => demo.persona.email);
    expect(new Set(emails).size).toBe(emails.length);
    for (const email of emails) expect(email).toMatch(/@acme\.example$/);
  });

  it("names only sources that exist, so a typo cannot leave a clip forever fresh", () => {
    const files = walk("apps/cloud/src");
    for (const demo of DEMOS) {
      expect(demo.dependencies.length).toBeGreaterThan(0);
      for (const glob of demo.dependencies) {
        const pattern = globToRegExp(glob);
        expect(files.some((file) => pattern.test(file)), `${demo.id}: ${glob}`).toBe(true);
      }
    }
  });

  it("says which four files a recording produces", () => {
    expect(outputsOf("dashboard-graph")).toEqual([
      "static/demos/dashboard-graph.mp4",
      "static/demos/dashboard-graph-bleed.mp4",
      "static/demos/dashboard-graph.webp",
      "static/demos/dashboard-graph-bleed.webp",
    ]);
  });
});
