import type { Metadata } from "next";
import { SubscriptionView } from "@/features/billing/subscription-view";

export const metadata: Metadata = { title: "Langganan & Tagihan" };

export default function SubscriptionPage() {
  return <SubscriptionView />;
}
