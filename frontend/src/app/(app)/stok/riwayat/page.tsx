import type { Metadata } from "next";
import { Suspense } from "react";
import { StockHistoryView } from "@/features/stock/stock-history";

export const metadata: Metadata = { title: "Riwayat Stok" };

export default function StockHistoryPage() {
  // the view reads the SKU, warehouse, and type from the URL
  return (
    <Suspense>
      <StockHistoryView />
    </Suspense>
  );
}
