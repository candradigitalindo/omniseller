import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthorizationCallback } from "@/features/stores/authorization-callback";

export const metadata: Metadata = { title: "Menghubungkan toko" };

/** Where Shopee and Tokopedia & Shop send the seller back after the consent page (backend 8.2). */
export default async function AuthorizationCallbackPage({ params }: PageProps<"/integrasi/callback/[channel]">) {
  const { channel } = await params;
  return (
    <Suspense>
      <AuthorizationCallback channel={channel} />
    </Suspense>
  );
}
