"use client";

import { cn } from "cn";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/** A toggle in a filter bar (8.3): pressed chips are tinted and show an x to clear them. */
export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 whitespace-nowrap text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary-100 bg-primary-100 text-primary-600"
          : "border-border-strong bg-surface text-text-700 hover:bg-surface-2",
      )}
    >
      {children}
      {active ? <X className="size-3.5" aria-hidden /> : null}
    </button>
  );
}
