import type { Metadata } from "next";
import { OrderRulesView } from "@/features/order-rules/order-rules-view";

export const metadata: Metadata = { title: "Aturan Otomatis" };

export default function OrderRulesPage() {
  return <OrderRulesView />;
}
