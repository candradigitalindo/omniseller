import type { Metadata } from "next";
import { WarehousesView } from "@/features/warehouses/warehouses-view";

export const metadata: Metadata = { title: "Gudang" };

export default function WarehousesPage() {
  return <WarehousesView />;
}
