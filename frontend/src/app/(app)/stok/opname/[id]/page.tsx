import type { Metadata } from "next";
import { Suspense } from "react";
import { CountDetailView } from "@/features/stock-ops/count-detail";

export const metadata: Metadata = { title: "Stock Opname" };

export default async function CountPage({ params }: PageProps<"/stok/opname/[id]">) {
  const { id } = await params;
  // the view keeps its line filter and search in the URL
  return (
    <Suspense>
      <CountDetailView id={id} />
    </Suspense>
  );
}
