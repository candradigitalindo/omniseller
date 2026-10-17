import type { Metadata } from "next";
import { CommerceInboxView } from "@/features/commerce-inbox/commerce-inbox-view";
export const metadata: Metadata = { title: "Pesan Marketplace" };
export default function CommerceInboxPage() {
  return <CommerceInboxView />;
}
