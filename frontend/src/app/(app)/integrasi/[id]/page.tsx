import type { Metadata } from "next";
import { Suspense } from "react";
import { StorePage } from "@/features/stores/store-page";

export const metadata: Metadata = { title: "Kelola Toko" };

export default async function StoreAdminPage({ params }: PageProps<"/integrasi/[id]">) {
  const { id } = await params;
  // the tab and the log filter live in the URL
  return (
    <Suspense>
      <StorePage id={id} />
    </Suspense>
  );
}
