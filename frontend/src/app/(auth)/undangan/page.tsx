import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingState } from "@/components/common/loading-state";
import { InvitationForm } from "@/features/auth/invitation-form";

export const metadata: Metadata = { title: "Terima undangan" };

export default function InvitationPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <InvitationForm />
    </Suspense>
  );
}
