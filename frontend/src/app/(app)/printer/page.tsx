import type { Metadata } from "next";
import { PrintersView } from "@/features/printers/printers-view";

export const metadata: Metadata = { title: "Printer & Label" };

export default function PrintersPage() {
  return <PrintersView />;
}
