import type { Metadata } from "next";
import { Suspense } from "react";
import { CountsView } from "@/features/stock-ops/counts-view";

export const metadata: Metadata = { title: "Stock Opname" };

export default function CountsPage() {
  // the view reads its filter from the URL
  return (
    <Suspense>
      <CountsView />
    </Suspense>
  );
}
