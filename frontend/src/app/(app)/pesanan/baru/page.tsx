import type { Metadata } from "next";
import { ManualOrderForm } from "@/features/orders/manual-order-form";

export const metadata: Metadata = { title: "Pesanan Manual Baru" };

export default function ManualOrderPage() {
  return <ManualOrderForm />;
}
