import type { Metadata } from "next";
import { Suspense } from "react";
import { MigrationView } from "@/features/migration/migration-view";

export const metadata: Metadata = { title: "Migrasi Data" };

export default function MigrationPage() {
  // the view keeps its tab and the open import in the URL
  return (
    <Suspense>
      <MigrationView />
    </Suspense>
  );
}
