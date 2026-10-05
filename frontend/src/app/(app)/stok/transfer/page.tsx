import type { Metadata } from "next";
import { Suspense } from "react";
import { TransfersView } from "@/features/stock-ops/transfers-view";

export const metadata: Metadata = { title: "Transfer Stok" };

export default function TransfersPage() {
  // the view reads its filter and the open transfer from the URL
  return (
    <Suspense>
      <TransfersView />
    </Suspense>
  );
}
