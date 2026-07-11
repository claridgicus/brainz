/**
 * Wave G expiry enforcement at the single bearer-auth chokepoint: keys whose
 * provisional owner is past `expires_at` are unauthorized with an actionable
 * message. The rule itself is pure (`isOwnerExpired`); resolveApiKey applies
 * it after the key→vault→owner join, throwing a 401 HttpError that both the
 * REST `guarded` wrapper and the /mcp route surface verbatim.
 */
import { describe, expect, it } from "vitest";
import { HttpError } from "./api-util";
import { isOwnerExpired, WORKSPACE_EXPIRED_MESSAGE } from "./vault-access";

const NOW = new Date("2026-07-10T00:00:00.000Z");

describe("isOwnerExpired", () => {
  it("NULL expiry = permanent account (human-created or claimed) — never expires", () => {
    expect(isOwnerExpired(null, NOW)).toBe(false);
  });

  it("a future expiry keeps the key working (provisional but within 7 days)", () => {
    expect(isOwnerExpired(new Date(NOW.getTime() + 1), NOW)).toBe(false);
    expect(isOwnerExpired(new Date("2026-07-17T00:00:00.000Z"), NOW)).toBe(false);
  });

  it("a past expiry rejects", () => {
    expect(isOwnerExpired(new Date(NOW.getTime() - 1), NOW)).toBe(true);
    expect(isOwnerExpired(new Date("2026-07-01T00:00:00.000Z"), NOW)).toBe(true);
  });

  it("the exact expiry instant is still valid (strictly past-expiry rejects)", () => {
    expect(isOwnerExpired(new Date(NOW.getTime()), NOW)).toBe(false);
  });
});

describe("the expired-workspace rejection", () => {
  it("is a 401 with the actionable Wave G message", () => {
    // resolveApiKey throws exactly this; REST's `guarded` maps it to
    // {error: message} with the status, and /mcp returns it in the 401 body.
    const err = new HttpError(401, WORKSPACE_EXPIRED_MESSAGE);
    expect(err.status).toBe(401);
    expect(err.message).toBe(
      "workspace expired unclaimed — sign up again, or ask your human to approve the claim email",
    );
  });
});
