import { cn } from "cn";
import type * as React from "react";

/** Text inputs of DOKUMEN-UI-UX 8.2: 48 px on phones, 40 px from tablets up, border darker on hover. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-12 w-full min-w-0 rounded-lg border border-input bg-surface px-3 text-base text-text-900 transition-colors outline-none placeholder:text-text-500 hover:border-border-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-disabled aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 md:h-10 md:text-[15px] file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
