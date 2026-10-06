import type { Metadata } from "next";
import { AccountView } from "@/features/account/account-view";

export const metadata: Metadata = { title: "Akun saya" };

export default function AccountPage() {
  return <AccountView />;
}
