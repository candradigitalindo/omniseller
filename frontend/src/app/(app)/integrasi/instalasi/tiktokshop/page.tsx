import type { Metadata } from "next";
import { Suspense } from "react";
import { AppStoreInstallation } from "@/features/stores/app-store-installation";

export const metadata: Metadata = { title: "Pemasangan Tokopedia & Shop", robots: { index: false, follow: false } };

export default function StoreInstallationPage() {
  return (
    <Suspense>
      <AppStoreInstallation />
    </Suspense>
  );
}
