import type { AuditEntry } from "./audit-meta";

/** Audit entries for tests, as the api returns them (backend doc 8.28); each call gets its own id. */
let n = 0;
export function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  n += 1;
  return {
    id: `01JAUDIT${String(n).padStart(18, "0")}`,
    at: "2026-10-06T10:50:00.000Z",
    actorType: "user",
    actorId: "01JUSER0000000000000000000",
    requestId: `req-${n}`,
    action: "update",
    entityType: "variant",
    entityId: "01JVARIANT0000000000000001",
    before: null,
    after: null,
    actor: { type: "user", id: "01JUSER0000000000000000000", name: "Rina Wulandari" },
    change: "updated",
    label: "KAOS-HTM-L",
    changes: [{ field: "basePrice", before: 65_000, after: 69_000 }],
    ...over,
  };
}
