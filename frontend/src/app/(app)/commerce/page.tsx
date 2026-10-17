import type { Metadata } from "next";
import { CommerceView } from "@/features/commerce/commerce-view";

export const metadata: Metadata = { title: "Fitur Commerce" };

export default function CommercePage() {
  return <CommerceView />;
}
