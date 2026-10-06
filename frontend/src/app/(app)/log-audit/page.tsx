import type { Metadata } from "next";
import { Suspense } from "react";
import { AuditLogView } from "@/features/audit/audit-log-view";

export const metadata: Metadata = { title: "Log Audit" };

export default function AuditLogPage() {
  return (
    <Suspense>
      <AuditLogView />
    </Suspense>
  );
}
