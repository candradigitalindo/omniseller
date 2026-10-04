import type { Metadata } from "next";
import { SignupForm } from "@/features/auth/signup-form";

export const metadata: Metadata = { title: "Daftar" };

export default function SignupPage() {
  return <SignupForm />;
}
