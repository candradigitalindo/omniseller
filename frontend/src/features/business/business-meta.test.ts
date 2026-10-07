import { describe, expect, it } from "vitest";
import { documentBadge, draftOf, formatNpwp, patchOf, problemsOf } from "./business-meta";
import { PROFILE } from "./fixtures";

describe("business profile form", () => {
  it("starts from what is saved, with the NPWP as printed on the card", () => {
    const d = draftOf(PROFILE);
    expect(d).toMatchObject({ nibMode: "missing", nib: "", npwp: "12.345.678.9-012.000", district: "" });
    expect(patchOf(d, PROFILE)).toEqual({});
  });

  it("sends only what changed, numbers as digits, empty fields as nothing", () => {
    const d = {
      ...draftOf(PROFILE),
      name: " Toko Rina Jaya ",
      phone: "",
      nibMode: "registered" as const,
      nib: "1234 5678 90123",
    };
    expect(patchOf(d, PROFILE)).toEqual({
      name: "Toko Rina Jaya",
      phone: null,
      nib: "1234567890123",
      nibInProcessSince: null,
    });
    // the address goes whole when any part of it changes, without its empty parts
    const moved = { ...draftOf(PROFILE), district: "Coblong", postalCode: "" };
    expect(patchOf(moved, PROFILE)).toEqual({
      address: { line1: "Jl. Melati No. 5", district: "Coblong", city: "Kota Bandung", province: "Jawa Barat" },
    });
    // the same NPWP typed differently is no change; a new time zone is
    expect(patchOf({ ...draftOf(PROFILE), npwp: "123456789012000", timezone: "Asia/Makassar" }, PROFILE)).toEqual({
      timezone: "Asia/Makassar",
    });
    expect(patchOf({ ...draftOf(PROFILE), npwp: "", pkp: true }, PROFILE)).toEqual({ npwp: null, pkp: true });
    // the saved phone typed with dashes is the same phone
    expect(patchOf({ ...draftOf(PROFILE), phone: "0812-3456-7890" }, PROFILE)).toEqual({});
  });

  it("switches between an NIB, an NIB in process, and none", () => {
    const inProcess = {
      ...PROFILE,
      nibStatus: "in_process" as const,
      nibInProcessSince: "2026-05-01",
      nibDeadline: "2026-11-01",
      nibDaysLeft: 25,
    };
    expect(patchOf({ ...draftOf(inProcess), nibMode: "missing" }, inProcess)).toEqual({
      nib: null,
      nibInProcessSince: null,
    });
    expect(patchOf({ ...draftOf(PROFILE), nibMode: "in_process", nibInProcessSince: "2026-09-01" }, PROFILE)).toEqual({
      nib: null,
      nibInProcessSince: "2026-09-01",
    });
  });

  it("names what stops a save", () => {
    const d = draftOf(PROFILE);
    expect(problemsOf(d, PROFILE.today)).toEqual({});
    expect(
      problemsOf(
        { ...d, name: "T", postalCode: "401", phone: "12", nibMode: "registered", nib: "123", npwp: "1234" },
        PROFILE.today,
      ),
    ).toEqual({ name: "nameLength", postalCode: "postalCode", phone: "phone", nib: "nibDigits", npwp: "npwpDigits" });
    expect(problemsOf({ ...d, nibMode: "in_process", nibInProcessSince: "" }, PROFILE.today)).toEqual({
      nibInProcessSince: "sinceRequired",
    });
    expect(problemsOf({ ...d, nibMode: "in_process", nibInProcessSince: "2026-10-08" }, PROFILE.today)).toEqual({
      nibInProcessSince: "sinceFuture",
    });
  });

  it("prints the old NPWP with its dots and the new one as it is", () => {
    expect(formatNpwp("123456789012000")).toBe("12.345.678.9-012.000");
    expect(formatNpwp("3201234567890001")).toBe("3201234567890001");
  });

  it("reads a document's validity", () => {
    expect(documentBadge({ status: "no_expiry", daysLeft: null, validUntil: null })).toEqual({
      tone: "neutral",
      key: "noExpiry",
    });
    expect(documentBadge({ status: "valid", daysLeft: 400, validUntil: "2027-11-11" }).key).toBe("validUntil");
    expect(documentBadge({ status: "expiring", daysLeft: 0, validUntil: "2026-10-07" })).toEqual({
      tone: "warning",
      key: "expiresToday",
    });
    expect(documentBadge({ status: "expiring", daysLeft: 9, validUntil: "2026-10-16" }).key).toBe("expiresIn");
    expect(documentBadge({ status: "expired", daysLeft: -2, validUntil: "2026-10-05" })).toEqual({
      tone: "danger",
      key: "expiredOn",
    });
  });
});
