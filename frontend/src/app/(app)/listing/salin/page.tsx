import type { Metadata } from "next";
import { Suspense } from "react";
import { CopiesView } from "@/features/listing-copy/copies-view";

export const metadata: Metadata = { title: "Salin Listing" };

export default function CopyListingsPage() {
  // the view reads its tab and filters from the URL
  return (
    <Suspense>
      <CopiesView />
    </Suspense>
  );
}
