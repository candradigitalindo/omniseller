import type { Metadata } from "next";
import { Suspense } from "react";
import { TeamView } from "@/features/team/team-view";

export const metadata: Metadata = { title: "Tim & Peran" };

export default function TeamPage() {
  // the view keeps its tab in the URL
  return (
    <Suspense>
      <TeamView />
    </Suspense>
  );
}
