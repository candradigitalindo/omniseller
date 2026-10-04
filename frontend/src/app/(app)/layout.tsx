import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";

/** Every page after signing in shares the shell: session, sidebar, top bar, bottom navigation. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
