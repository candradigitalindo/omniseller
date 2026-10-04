import type { Metadata } from "next";
import { StoresView } from "@/features/stores/stores-view";

export const metadata: Metadata = { title: "Toko Terhubung" };

export default function StoresPage() {
  return <StoresView />;
}
