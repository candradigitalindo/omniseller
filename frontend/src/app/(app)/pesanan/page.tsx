import type { Metadata } from "next";
import { Suspense } from "react";
import { OrdersView } from "@/features/orders/orders-view";

export const metadata: Metadata = { title: "Pesanan" };

export default function OrdersPage() {
  // the view reads its filters from the URL
  return (
    <Suspense>
      <OrdersView />
    </Suspense>
  );
}
