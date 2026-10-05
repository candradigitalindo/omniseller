import type { Metadata } from "next";
import { Suspense } from "react";
import { ProductsView } from "@/features/products/products-view";

export const metadata: Metadata = { title: "Produk" };

export default function ProductsPage() {
  // the view reads its search and filter from the URL
  return (
    <Suspense>
      <ProductsView />
    </Suspense>
  );
}
