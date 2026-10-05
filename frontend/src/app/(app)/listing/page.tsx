import type { Metadata } from "next";
import { Suspense } from "react";
import { ListingsView } from "@/features/listings/listings-view";

export const metadata: Metadata = { title: "Listing Toko" };

export default function ListingsPage() {
  // the view reads its tab, store, and search from the URL
  return (
    <Suspense>
      <ListingsView />
    </Suspense>
  );
}
