import type { Metadata } from "next";
import { Suspense } from "react";
import { InvitationForm } from "@/features/auth/invitation-form";

export const metadata: Metadata = { title: "Terima undangan" };

export default function InvitationPage() {
  return (
    <Suspense>
      <InvitationForm />
    </Suspense>
  );
}
