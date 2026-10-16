import { cn } from "cn";
import type { ComponentProps } from "react";

export const inputClassName =
  "h-12 w-full min-w-0 rounded-xl border border-input bg-surface px-3.5 text-base text-text-900 shadow-xs transition-[border-color,box-shadow,background-color] outline-none placeholder:text-text-500 hover:border-border-strong focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/10 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-disabled aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/15 md:h-10 md:text-[15px] file:border-0 file:bg-transparent file:text-sm";

export function BaseInput({ className, ...props }: ComponentProps<"input">) {
  return <input data-slot="input" className={cn(inputClassName, className)} {...props} />;
}
