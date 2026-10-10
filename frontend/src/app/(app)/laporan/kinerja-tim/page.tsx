import type { Metadata } from "next";
import { Suspense } from "react";
import { StaffReportView } from "@/features/reports/staff-report";

export const metadata: Metadata = { title: "Kinerja Tim" };

export default function StaffReportPage() {
  // the view reads its period and member from the URL
  return (
    <Suspense>
      <StaffReportView />
    </Suspense>
  );
}
