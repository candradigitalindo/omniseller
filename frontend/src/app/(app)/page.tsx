import type { Metadata } from "next";
import { DashboardView } from "@/features/dashboard/dashboard";

export const metadata: Metadata = { title: "Ringkasan" };

export default function HomePage() {
  return <DashboardView />;
}
