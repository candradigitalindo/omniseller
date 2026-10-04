"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { type ReactNode, useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { handleSessionEnded } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { leaveTo } from "@/lib/navigate";

/** Retries only what may pass on a second try: the network, or the server failing. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 2;
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: shouldRetry, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}

/**
 * Everything client-side the app needs once: server data (TanStack Query), the light or dark theme the
 * user picked (never the system's, DOKUMEN-UI-UX 4.3), tooltips, and toasts. When the api says the
 * session ended, the whole page goes to `/masuk` and comes back afterwards.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);

  useEffect(() => {
    let ended = false;
    handleSessionEnded(() => {
      if (ended) return;
      ended = true;
      const here = `${window.location.pathname}${window.location.search}`;
      leaveTo(here === "/" ? "/masuk" : `/masuk?next=${encodeURIComponent(here)}`);
    });
    return () => handleSessionEnded(null);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
        <TooltipProvider delayDuration={300}>
          {children}
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
