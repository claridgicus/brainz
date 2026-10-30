import { describe, expect, it } from "vitest";
import { allowedCpus, projectName, stackPort } from "../src/stack.js";
import { emlPathsIn, verifyPathIn } from "../src/tenant.js";

describe("the demo stack's name and port", () => {
  it("is named after the worktree", () => {
    expect(projectName("/home/me/code/brainz")).toBe("brainz-demos");
    expect(projectName("/home/me/code/brainz-demos")).toBe("brainz-demos");
    expect(projectName("/home/me/code/Feature_X")).toBe("brainz-demos-feature-x");
  });

  it("derives a stable port in 8800–8899 from the name", () => {
    const port = stackPort("brainz-demos-feature-x");
    expect(port).toBe(stackPort("brainz-demos-feature-x"));
    expect(port).toBeGreaterThanOrEqual(8800);
    expect(port).toBeLessThan(8900);
  });

  it("reads the CPU block it runs on", () => {
    expect(allowedCpus("Name:\tnode\nCpus_allowed_list:\t8-15\n")).toBe("8-15");
    expect(allowedCpus("")).toBeUndefined();
  });
});

describe("the magic link in a captured email", () => {
  it("finds the .eml files the mailer stub logged", () => {
    const log = [
      "send_email binding called with the following message:",
      "  /tmp/miniflare-1/email/email/a.eml",
      "[wrangler:info] POST /api/auth/sign-in/magic-link 200 OK",
      "\u001b[34msend_email binding called with the following message:\u001b[39m",
      "  /tmp/miniflare-1/email/email/b.eml",
    ].join("\n");
    expect(emlPathsIn(log)).toEqual(["/tmp/miniflare-1/email/email/a.eml", "/tmp/miniflare-1/email/email/b.eml"]);
  });

  it("takes the verify path, whatever host the email names", () => {
    const html = '<a href="http://brainz.brownmatter.ai/api/auth/magic-link/verify?token=abc&amp;callbackURL=%2Fdashboard">';
    expect(verifyPathIn(html)).toBe("/api/auth/magic-link/verify?token=abc&callbackURL=%2Fdashboard");
    expect(verifyPathIn("no link here")).toBeUndefined();
  });
});
