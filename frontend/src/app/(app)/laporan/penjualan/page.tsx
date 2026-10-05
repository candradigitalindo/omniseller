import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesReportView } from "@/features/reports/sales-report";

export const metadata: Metadata = { title: "Laporan Penjualan" };

export default function SalesReportPage() {
  // the view reads its filters from the URL
  return (
    <Suspense>
      <SalesReportView />
    </Suspense>
  );
}
