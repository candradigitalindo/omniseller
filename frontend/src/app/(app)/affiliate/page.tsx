import type { Metadata } from "next";
import { AffiliateProductsView } from "@/features/affiliate/affiliate-products-view";
export const metadata: Metadata = { title: "AMS Shopee" };
export default function AffiliatePage() {
  return <AffiliateProductsView />;
}
