import type { ReactNode } from "react";
import { Logo } from "@/components/common/logo";

/** Signing in and its siblings (L49): one 420 px card in the middle of the canvas, the logo above it. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-canvas px-4 py-10">
      <Logo />
      <div className="w-full max-w-[420px] rounded-[10px] border border-border bg-surface p-6 shadow-card md:p-8">
        {children}
      </div>
    </main>
  );
}
