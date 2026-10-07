import { generate } from "otplib";
import { describe, expect, it } from "vitest";
import { newBackupCodes, newTotpSecret, normalizeBackupCode, TwoFactorKeys, totpUri, verifyTotp } from "./two-factor";

const KEY = Buffer.alloc(32, 5).toString("base64");
const at = (iso: string) => new Date(iso);
const epoch = (iso: string) => Math.floor(at(iso).getTime() / 1000);

describe("TOTP", () => {
  it("makes a 160-bit base32 secret and the link authenticator apps read", () => {
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const uri = totpUri("OmniSeller", "rina@contoh.id", secret);
    expect(uri).toMatch(/^otpauth:\/\/totp\/OmniSeller:rina%40contoh\.id\?/);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("issuer=OmniSeller");
  });

  it("accepts the code of this step and of the steps next to it, and nothing further", async () => {
    const secret = newTotpSecret();
    const code = await generate({ secret, epoch: epoch("2026-10-07T10:00:05Z") });
    const step = await verifyTotp(secret, code, { now: at("2026-10-07T10:00:05Z") });
    expect(step).toBe(Math.floor(epoch("2026-10-07T10:00:05Z") / 30));
    expect(await verifyTotp(secret, code, { now: at("2026-10-07T10:00:35Z") })).toBe(step);
    expect(await verifyTotp(secret, code, { now: at("2026-10-07T09:59:40Z") })).toBe(step);
    expect(await verifyTotp(secret, code, { now: at("2026-10-07T10:01:10Z") })).toBeNull();
    expect(await verifyTotp(newTotpSecret(), code, { now: at("2026-10-07T10:00:05Z") })).toBeNull();
  });

  it("refuses a code of a step already used, so a code cannot sign in twice", async () => {
    const secret = newTotpSecret();
    const now = at("2026-10-07T10:00:05Z");
    const code = await generate({ secret, epoch: epoch("2026-10-07T10:00:05Z") });
    const step = (await verifyTotp(secret, code, { now }))!;
    expect(await verifyTotp(secret, code, { now, afterStep: step })).toBeNull();
    expect(await verifyTotp(secret, code, { now, afterStep: step - 1 })).toBe(step);
    // the next step's code is still good
    const next = await generate({ secret, epoch: epoch("2026-10-07T10:00:35Z") });
    expect(await verifyTotp(secret, next, { now: at("2026-10-07T10:00:35Z"), afterStep: step })).toBe(step + 1);
  });

  it("refuses anything that is not six digits without asking the library", async () => {
    const secret = newTotpSecret();
    for (const code of ["", "12345", "1234567", "12345a", " 123456"]) {
      expect(await verifyTotp(secret, code)).toBeNull();
    }
  });
});

describe("backup codes", () => {
  it("makes ten different codes without letters that look alike", () => {
    const codes = newBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
  });

  it("reads a code however it is typed", () => {
    expect(normalizeBackupCode(" K7M2Q-x9p4w ")).toBe("k7m2qx9p4w");
    expect(normalizeBackupCode("k7m2q x9p4w")).toBe("k7m2qx9p4w");
  });
});

describe("TwoFactorKeys", () => {
  const keys = new TwoFactorKeys(KEY);

  it("seals a secret for one user only", () => {
    const sealed = keys.seal("01TENANT", "01USERA", "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(sealed.toString("utf8")).not.toContain("JBSWY3DP");
    expect(keys.open("01TENANT", "01USERA", sealed)).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    // copied onto another user's row, or opened with another key, it does not open
    expect(() => keys.open("01TENANT", "01USERB", sealed)).toThrow();
    expect(() => keys.open("01OTHER", "01USERA", sealed)).toThrow();
    expect(() =>
      new TwoFactorKeys(Buffer.alloc(32, 6).toString("base64")).open("01TENANT", "01USERA", sealed),
    ).toThrow();
  });

  it("keeps a backup code as an HMAC that depends on the user and the key, not on how it was typed", () => {
    const h = keys.hashBackupCode("01USERA", "k7m2q-x9p4w");
    expect(h).not.toContain("k7m2q");
    expect(keys.hashBackupCode("01USERA", "K7M2Q X9P4W")).toBe(h);
    expect(keys.hashBackupCode("01USERB", "k7m2q-x9p4w")).not.toBe(h);
    expect(new TwoFactorKeys(Buffer.alloc(32, 6).toString("base64")).hashBackupCode("01USERA", "k7m2q-x9p4w")).not.toBe(
      h,
    );
  });

  it("needs a 32-byte key", () => {
    expect(() => new TwoFactorKeys(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
