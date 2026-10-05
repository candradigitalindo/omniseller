import type { Metadata } from "next";
import { Suspense } from "react";
import { ProductDetailView } from "@/features/products/product-detail";

export const metadata: Metadata = { title: "Detail produk" };

export default async function ProductPage({ params }: PageProps<"/produk/[id]">) {
  const { id } = await params;
  // the view keeps its tab in the URL
  return (
    <Suspense>
      <ProductDetailView id={id} />
    </Suspense>
  );
}
