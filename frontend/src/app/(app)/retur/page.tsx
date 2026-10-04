import type { Metadata } from "next";
import { Suspense } from "react";
import { ReturnsView } from "@/features/returns/returns-view";

export const metadata: Metadata = { title: "Retur & Batal" };

export default function ReturnsPage() {
  // the view reads its tab and filters from the URL
  return (
    <Suspense>
      <ReturnsView />
    </Suspense>
  );
}
