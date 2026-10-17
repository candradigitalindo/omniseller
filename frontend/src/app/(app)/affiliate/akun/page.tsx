import type { Metadata } from "next";
import { AffiliateAccountsView } from "@/features/affiliate-accounts/accounts-view";
export const metadata: Metadata = { title: "Akun Creator & Partner" };
export default function AffiliateAccountsPage() {
  return <AffiliateAccountsView />;
}
