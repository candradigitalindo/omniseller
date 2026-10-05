import type { Metadata } from "next";
import { Suspense } from "react";
import { ShippingView } from "@/features/shipping/shipping-view";

export const metadata: Metadata = { title: "Pengiriman" };

export default function ShippingPage() {
  // the view keeps its tab and open manifest in the URL
  return (
    <Suspense>
      <ShippingView />
    </Suspense>
  );
}
