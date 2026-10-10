import { describe, expect, it } from "vitest";
import messages from "../../../messages/id.json";
import {
  AUDIT_FIELDS,
  AUDIT_KINDS,
  daysValue,
  fileChangeKey,
  groupEntries,
  periodFrom,
  plainValue,
  shownChanges,
  TITLE_KEYS,
  titleKey,
  VALUE_LABELS,
  valueKey,
  weekValue,
} from "./audit-meta";
import { entry } from "./fixtures";

const status = (before: string | null, after: string) => [{ field: "status", before, after }];

describe("what an entry says", () => {
  it("names the step a status change took", () => {
    expect(titleKey(entry({ entityType: "handover", changes: status("open", "completed") }))).toBe(
      "handover_completed",
    );
    expect(titleKey(entry({ entityType: "handover", changes: status("open", "cancelled") }))).toBe(
      "handover_cancelled",
    );
    expect(titleKey(entry({ entityType: "store", changes: status("active", "disconnected") }))).toBe(
      "store_disconnected",
    );
    // a business closing its account and reopening it (backend doc 8.36)
    expect(titleKey(entry({ entityType: "tenant", changes: status("active", "closing") }))).toBe("tenant_closing");
    expect(titleKey(entry({ entityType: "tenant", changes: status("closing", "active") }))).toBe("tenant_reopened");
    expect(titleKey(entry({ entityType: "tenant", changes: status("active", "suspended") }))).toBe("tenant_updated");
    expect(titleKey(entry({ entityType: "store", changes: status("reauth_required", "active") }))).toBe(
      "store_updated",
    );
    expect(titleKey(entry({ entityType: "stock_transfer", changes: status("draft", "sent") }))).toBe(
      "stock_transfer_sent",
    );
    expect(titleKey(entry({ entityType: "stock_transfer", changes: status("sent", "received") }))).toBe(
      "stock_transfer_received",
    );
    expect(titleKey(entry({ entityType: "stock_count", changes: status("counting", "review") }))).toBe(
      "stock_count_submitted",
    );
    expect(titleKey(entry({ entityType: "stock_count", changes: status("review", "counting") }))).toBe(
      "stock_count_reopened",
    );
    expect(
      titleKey(
        entry({
          entityType: "stock_count",
          changes: [{ field: "applyRequestedAt", before: null, after: "2026-10-06T10:50:00Z" }],
        }),
      ),
    ).toBe("stock_count_approved");
    expect(titleKey(entry({ entityType: "stock_count", changes: status("review", "applied") }))).toBe(
      "stock_count_applied",
    );
  });

  it("tells a stock change by its kind, a download, a revoked agent, and an answered return", () => {
    const movement = (type: string) =>
      entry({
        entityType: "stock_movement",
        change: "created",
        changes: [{ field: "type", before: null, after: type }],
      });
    expect(titleKey(movement("adjustment"))).toBe("stock_movement_adjustment");
    expect(titleKey(movement("count_apply"))).toBe("stock_movement_count_apply");
    expect(
      titleKey(entry({ entityType: "data_export", changes: [{ field: "downloadCount", before: 0, after: 1 }] })),
    ).toBe("data_export_downloaded");
    expect(
      titleKey(
        entry({ entityType: "device", changes: [{ field: "revokedAt", before: null, after: "2026-10-06T10:50:00Z" }] }),
      ),
    ).toBe("device_revoked");
    expect(
      titleKey(entry({ entityType: "device", changes: [{ field: "name", before: "PC 1", after: "PC Gudang" }] })),
    ).toBe("device_updated");
    // a time corrected is not the step happening
    expect(
      titleKey(
        entry({
          entityType: "device",
          changes: [{ field: "revokedAt", before: "2026-10-05T10:00:00Z", after: "2026-10-06T10:50:00Z" }],
        }),
      ),
    ).toBe("device_updated");
    expect(
      titleKey(
        entry({ entityType: "return_request", changes: [{ field: "responseStatus", before: null, after: "sent" }] }),
      ),
    ).toBe("return_request_answered");
    expect(
      titleKey(
        entry({
          entityType: "return_request",
          changes: [{ field: "receivedAt", before: null, after: "2026-10-06T10:50:00Z" }],
        }),
      ),
    ).toBe("return_request_received");
  });

  it("says whether an account was disabled, enabled again, or had its two-step verification turned on or off", () => {
    const twoFactor = (before: boolean, after: boolean) => [{ field: "twoFactorEnabled", before, after }];
    expect(titleKey(entry({ entityType: "user", changes: twoFactor(false, true) }))).toBe("user_two_factor_on");
    expect(titleKey(entry({ entityType: "user", changes: twoFactor(true, false) }))).toBe("user_two_factor_off");
    expect(titleKey(entry({ entityType: "user", changes: status("active", "disabled") }))).toBe("user_disabled");
    expect(titleKey(entry({ entityType: "user", changes: status("disabled", "active") }))).toBe("user_enabled");
    expect(titleKey(entry({ entityType: "user", changes: status("invited", "invited") }))).toBe("user_updated");
    expect(valueKey("user", "status", "disabled")).toBe("team.userStatus_disabled");
    expect(AUDIT_KINDS.access).toContain("user");
  });

  it("reads courier days and weekly hours as days", () => {
    expect(daysValue([0, 1, 2, 3, 4, 5, 6])).toBe("Sen, Sel, Rab, Kam, Jum, Sab, Min");
    expect(daysValue([6, 1])).toBe("Sen, Sab");
    expect(daysValue(["Sen"])).toBeNull();
    const week = [null, ...Array.from({ length: 6 }, () => ({ open: "08:00", close: "17:00" }))];
    expect(weekValue(week, "tutup")).toBe(
      "Sen 08.00–17.00, Sel 08.00–17.00, Rab 08.00–17.00, Kam 08.00–17.00, Jum 08.00–17.00, Sab 08.00–17.00, Min tutup",
    );
    expect(weekValue([1, 2, 3], "tutup")).toBeNull();
    expect(AUDIT_KINDS.stores).toContain("courier_cutoff");
  });

  it("names what happened to a subscription and its invoices (backend doc 8.32)", () => {
    const sub = (changes: { field: string; before: unknown; after: unknown }[]) =>
      titleKey(entry({ entityType: "subscription", changes }));
    expect(sub(status("trialing", "active"))).toBe("subscription_activated");
    expect(sub(status("past_due", "active"))).toBe("subscription_activated");
    expect(sub(status("active", "expired"))).toBe("subscription_ended");
    expect(sub(status("trialing", "cancelled"))).toBe("subscription_ended");
    expect(sub([{ field: "nextPlan", before: null, after: "Starter" }])).toBe("subscription_leaving");
    expect(sub([{ field: "nextPlan", before: "Growth", after: "Starter" }])).toBe("subscription_leaving");
    expect(sub([{ field: "nextPlan", before: "Growth", after: null }])).toBe("subscription_staying");
    expect(sub([{ field: "currentPeriodEnd", before: "2026-10-12", after: "2026-11-12" }])).toBe(
      "subscription_updated",
    );
    expect(titleKey(entry({ entityType: "subscription", change: "created" }))).toBe("subscription_created");
    const inv = (after: string) => titleKey(entry({ entityType: "invoice", changes: status("pending", after) }));
    expect(inv("paid")).toBe("invoice_paid");
    expect(inv("void")).toBe("invoice_void");
    expect(inv("expired")).toBe("invoice_expired");
    expect(inv("failed")).toBe("invoice_failed");
    expect(titleKey(entry({ entityType: "invoice", changes: status("failed", "pending") }))).toBe("invoice_updated");
    expect(valueKey("invoice", "status", "paid")).toBe("billing.invoiceStatus_paid");
    expect(valueKey("invoice", "paymentMethod", "BANK_TRANSFER")).toBe("billing.method_BANK_TRANSFER");
    expect(valueKey("subscription", "status", "past_due")).toBe("billing.status_past_due");
    expect(AUDIT_KINDS.business).toEqual(expect.arrayContaining(["subscription", "invoice"]));
  });

  it("says plainly what happened to a table it has no words for", () => {
    expect(titleKey(entry({ entityType: "future_table", change: "updated" }))).toBe("other_updated");
    expect(titleKey(entry({ entityType: "role_permission", change: "updated" }))).toBe("other_updated");
    expect(titleKey(entry({ change: "created" }))).toBe("variant_created");
  });

  it("has a message for every title and field label, and every value namespace exists", () => {
    const audit = messages.audit as Record<string, string>;
    expect(TITLE_KEYS.filter((k) => !audit[`title_${k}`])).toEqual([]);
    expect(AUDIT_FIELDS.filter((f) => !audit[`field_${f}`])).toEqual([]);
    for (const k of Object.keys(AUDIT_KINDS)) expect(audit[`kind_${k}`]).toBeTruthy();
    const all = messages as unknown as Record<string, Record<string, string>>;
    for (const [where, [ns, prefix]] of Object.entries(VALUE_LABELS)) {
      expect(
        Object.keys(all[ns] ?? {}).some((k) => k.startsWith(prefix)),
        where,
      ).toBe(true);
    }
  });

  it("says what happened to a file without its id", () => {
    expect(fileChangeKey(null, "01JFILE0000000000000000001")).toBe("fileAdded");
    expect(fileChangeKey("01JFILE0000000000000000001", "01JFILE0000000000000000002")).toBe("fileReplaced");
    expect(fileChangeKey("01JFILE0000000000000000001", null)).toBe("fileRemoved");
  });

  it("finds the label of a coded value where the screen that sets it keeps it", () => {
    expect(valueKey("store", "status", "disconnected")).toBe("stores.status_disconnected");
    expect(valueKey("stock_movement", "reason", "damaged")).toBe("stock.reason_damaged");
    expect(valueKey("handover", "status", "open")).toBe("shipping.handover_open");
    expect(valueKey("variant", "basePrice", 65_000)).toBeNull();
    expect(valueKey("future_table", "status", "x")).toBeNull();
  });
});

describe("values on one line", () => {
  it("writes attributes, addresses, and lists in words, and shortens long text", () => {
    expect(plainValue({ Warna: "Hitam", Ukuran: "L" })).toBe("Warna: Hitam, Ukuran: L");
    expect(plainValue({ line1: "Jl. Melati 5", city: "Kota Bandung", province: "Jawa Barat", phone: "0812" })).toBe(
      "Jl. Melati 5, Kota Bandung, Jawa Barat",
    );
    expect(plainValue(["Warna", "Ukuran"])).toBe("Warna, Ukuran");
    expect(plainValue([])).toBe("—");
    expect(plainValue("")).toBe("—");
    const long = plainValue("a".repeat(200));
    expect(long).toHaveLength(140);
    expect(long.endsWith("…")).toBe(true);
  });

  it("leaves out a created value that only repeats the entry's name", () => {
    const e = entry({
      entityType: "user_role",
      change: "created",
      label: "Sari Dewi",
      changes: [
        { field: "user", before: null, after: "Sari Dewi" },
        { field: "role", before: null, after: "CS" },
      ],
    });
    expect(shownChanges(e).map((c) => c.field)).toEqual(["role"]);
    const removed = entry({
      entityType: "user_role",
      change: "deleted",
      label: "Sari Dewi",
      changes: [
        { field: "user", before: "Sari Dewi", after: null },
        { field: "role", before: "Viewer", after: null },
      ],
    });
    expect(shownChanges(removed).map((c) => c.field)).toEqual(["role"]);
    // a rename keeps its old and new names
    const renamed = entry({
      label: "Gudang Baru",
      changes: [{ field: "name", before: "Gudang", after: "Gudang Baru" }],
    });
    expect(shownChanges(renamed)).toHaveLength(1);
  });
});

describe("one block per action", () => {
  it("joins neighbouring entries of one request by the same person, and nothing else", () => {
    const a = entry({ requestId: "R1" });
    const b = entry({ requestId: "R1" });
    const c = entry({ requestId: "R2" });
    const d = entry({ requestId: "R1" });
    const e = entry({ requestId: null });
    const f = entry({ requestId: null });
    const g = entry({
      requestId: "R3",
      actor: { type: "system", id: "system", name: null },
    });
    const h = entry({ requestId: "R3" });
    const i = entry({ requestId: "R3", actor: { type: "user", id: "01JUSER0000000000000000002", name: "Budi" } });
    expect(groupEntries([a, b, c, d, e, f, g, h, i]).map((x) => x.entries.map((y) => y.id))).toEqual([
      [a.id, b.id],
      [c.id],
      // the same request again, after another one: kept apart so the log stays in time order
      [d.id],
      [e.id],
      [f.id],
      [g.id],
      // one action is one person's: another actor in the same request stands apart
      [h.id],
      [i.id],
    ]);
  });

  it("counts a period back from now", () => {
    const now = Date.parse("2026-10-07T00:00:00.000Z");
    expect(periodFrom("7", now)).toBe("2026-09-30T00:00:00.000Z");
    expect(periodFrom("90", now)).toBe("2026-07-09T00:00:00.000Z");
  });
});
