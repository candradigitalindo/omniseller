import { describe, expect, it } from "vitest";
import {
  addMonths,
  daysBetween,
  digitsOf,
  documentStatus,
  dueDocumentStage,
  dueNibStage,
  legalTasks,
  nibDeadline,
  nibStatus,
} from "./business-plan";

describe("business profile rules (backend doc 8.29)", () => {
  it("reads numbers as people type them", () => {
    expect(digitsOf("12.345.678.9-012.000")).toBe("123456789012000");
    expect(digitsOf("1234 5678 90123")).toBe("1234567890123");
    expect(digitsOf("1234/5678")).toBe("12345678");
  });

  it("tells registered, in process, and missing apart", () => {
    expect(nibStatus({ nib: "1234567890123", nibInProcessSince: null })).toBe("registered");
    expect(nibStatus({ nib: null, nibInProcessSince: "2026-05-01" })).toBe("in_process");
    expect(nibStatus({ nib: null, nibInProcessSince: null })).toBe("missing");
  });

  it("gives six months to get an NIB, to the last day of a shorter month", () => {
    expect(nibDeadline("2026-04-15")).toBe("2026-10-15");
    expect(nibDeadline("2026-08-31")).toBe("2027-02-28");
    expect(addMonths("2027-08-31", 6)).toBe("2028-02-29");
    expect(addMonths("2026-11-30", 2)).toBe("2027-01-30");
    expect(daysBetween("2026-10-07", "2026-11-06")).toBe(30);
    expect(daysBetween("2026-10-07", "2026-10-06")).toBe(-1);
  });

  it("keeps a document valid through its last day, expiring within 30 days", () => {
    expect(documentStatus(null, "2026-10-07")).toEqual({ status: "no_expiry", daysLeft: null });
    expect(documentStatus("2028-03-12", "2026-10-07").status).toBe("valid");
    expect(documentStatus("2026-11-06", "2026-10-07")).toEqual({ status: "expiring", daysLeft: 30 });
    expect(documentStatus("2026-11-07", "2026-10-07").status).toBe("valid");
    expect(documentStatus("2026-10-07", "2026-10-07")).toEqual({ status: "expiring", daysLeft: 0 });
    expect(documentStatus("2026-10-06", "2026-10-07")).toEqual({ status: "expired", daysLeft: -1 });
  });

  it("sends each reminder once, and only the latest one reached", () => {
    const today = "2026-10-07";
    expect(dueDocumentStage("2026-12-01", today, null)).toBeNull();
    expect(dueDocumentStage("2026-11-06", today, null)).toBe("30d");
    expect(dueDocumentStage("2026-11-06", today, "30d")).toBeNull();
    expect(dueDocumentStage("2026-10-14", today, "30d")).toBe("7d");
    // uploaded a week before it ends: the 7-day reminder, not the 30-day one first
    expect(dueDocumentStage("2026-10-14", today, null)).toBe("7d");
    expect(dueDocumentStage("2026-10-06", today, "7d")).toBe("expired");
    expect(dueDocumentStage("2026-10-06", today, "expired")).toBeNull();
    expect(dueDocumentStage(null, today, null)).toBeNull();
  });

  it("reminds of the NIB deadline only while the NIB is in process", () => {
    const today = "2026-10-07";
    const inProcess = { nib: null, nibInProcessSince: "2026-04-20", nibRemindedStage: null };
    expect(dueNibStage(inProcess, today)).toBe("30d"); // deadline 2026-10-20, 13 days away
    expect(dueNibStage({ ...inProcess, nibRemindedStage: "30d" }, today)).toBeNull();
    expect(dueNibStage({ ...inProcess, nibInProcessSince: "2026-04-12", nibRemindedStage: "30d" }, today)).toBe("7d");
    expect(dueNibStage({ ...inProcess, nibInProcessSince: "2026-04-01", nibRemindedStage: "7d" }, today)).toBe(
      "passed",
    );
    expect(dueNibStage({ ...inProcess, nib: "1234567890123", nibInProcessSince: null }, today)).toBeNull();
    expect(dueNibStage({ ...inProcess, nibInProcessSince: null }, today)).toBeNull();
  });

  it("asks the keeper of legal papers to act on a missing NIB, a near deadline, and documents running out", () => {
    const today = "2026-10-07";
    expect(legalTasks({ nib: null, nibInProcessSince: null }, [], today)).toEqual([
      expect.objectContaining({ kind: "legal_nib", severity: "warning" }),
    ]);
    expect(legalTasks({ nib: null, nibInProcessSince: "2026-04-20" }, [], today)).toEqual([
      expect.objectContaining({ kind: "legal_nib", severity: "warning", title: "Batas proses NIB tinggal 13 hari" }),
    ]);
    expect(legalTasks({ nib: null, nibInProcessSince: "2026-03-01" }, [], today)).toEqual([
      expect.objectContaining({ kind: "legal_nib", severity: "critical" }),
    ]);
    // far from the deadline, nothing to do yet
    expect(legalTasks({ nib: null, nibInProcessSince: "2026-09-01" }, [], today)).toEqual([]);
    const docs = [
      { validUntil: "2026-10-01" },
      { validUntil: "2026-10-20" },
      { validUntil: null },
      { validUntil: "2030-01-01" },
    ];
    expect(legalTasks({ nib: "1234567890123", nibInProcessSince: null }, docs, today)).toEqual([
      {
        kind: "legal_documents",
        severity: "critical",
        count: 2,
        title: "2 dokumen legalitas habis berlaku atau segera habis",
      },
    ]);
    expect(legalTasks({ nib: "1234567890123", nibInProcessSince: null }, [docs[1]!], today)).toEqual([
      expect.objectContaining({ severity: "warning", title: "1 dokumen legalitas habis berlaku dalam 30 hari" }),
    ]);
  });
});
