import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingState } from "@/components/common/loading-state";
import { ResetPasswordForm } from "@/features/auth/password-forms";

export const metadata: Metadata = { title: "Buat kata sandi baru" };

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
