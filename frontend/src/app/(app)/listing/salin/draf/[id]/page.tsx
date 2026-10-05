import type { Metadata } from "next";
import { DraftEditor } from "@/features/listing-copy/draft-editor";

export const metadata: Metadata = { title: "Draf listing" };

export default async function DraftPage({ params }: PageProps<"/listing/salin/draf/[id]">) {
  const { id } = await params;
  return <DraftEditor id={id} />;
}
