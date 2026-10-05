import type { Metadata } from "next";
import { Suspense } from "react";
import { RestockView } from "@/features/stock/restock-view";

export const metadata: Metadata = { title: "Perlu Restock" };

export default function RestockPage() {
  // the view reads its filters from the URL
  return (
    <Suspense>
      <RestockView />
    </Suspense>
  );
}
