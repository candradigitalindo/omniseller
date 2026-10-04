import { cn } from "cn";

/** The OmniSeller mark: a sea-blue tile with a ring, and the name next to it unless `compact`. */
export function Logo({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-primary" />
        <circle cx="16" cy="16" r="8" fill="none" strokeWidth="3.5" className="stroke-primary-foreground" />
        <circle cx="22.5" cy="9.5" r="2.5" className="fill-primary-foreground" />
      </svg>
      {compact ? (
        <span className="sr-only">OmniSeller</span>
      ) : (
        <span className="font-heading text-lg font-bold tracking-tight text-text-900">OmniSeller</span>
      )}
    </span>
  );
}
