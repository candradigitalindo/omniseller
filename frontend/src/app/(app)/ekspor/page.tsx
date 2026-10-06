import type { Metadata } from "next";
import { DataExportView } from "@/features/settings/data-export";

export const metadata: Metadata = { title: "Ekspor Data" };

export default function DataExportPage() {
  return <DataExportView />;
}
