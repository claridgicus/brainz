import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password hashing (PBKDF2 / Web Crypto)", () => {
  it("hashes and verifies a password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^pbkdf2:100000:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword({ hash, password: "correct horse battery staple" })).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("password-one");
    expect(await verifyPassword({ hash, password: "password-two" })).toBe(false);
  });

  it("salts: same password → different hashes", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword({ hash: a, password: "same" })).toBe(true);
    expect(await verifyPassword({ hash: b, password: "same" })).toBe(true);
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword({ hash: "", password: "x" })).toBe(false);
    expect(await verifyPassword({ hash: "scrypt:1:2:3", password: "x" })).toBe(false);
    expect(await verifyPassword({ hash: "pbkdf2:not-a-number:a:b", password: "x" })).toBe(false);
  });
});
