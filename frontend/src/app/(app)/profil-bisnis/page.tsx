import type { Metadata } from "next";
import { BusinessProfileView } from "@/features/business/business-profile-view";

export const metadata: Metadata = { title: "Profil Bisnis & Legalitas" };

export default function BusinessProfilePage() {
  return <BusinessProfileView />;
}
