import type { Metadata } from "next";
import { Suspense } from "react";
import { StockView } from "@/features/stock/stock-view";

export const metadata: Metadata = { title: "Stok" };

export default function StockPage() {
  // the view reads its filters from the URL
  return (
    <Suspense>
      <StockView />
    </Suspense>
  );
}
