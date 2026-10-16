import type { Metadata } from "next";
import { ManualOrderModal } from "@/features/orders/manual-order-modal";

export const metadata: Metadata = { title: "Pesanan Manual Baru" };

export default function ManualOrderPage() {
  return <ManualOrderModal />;
}
