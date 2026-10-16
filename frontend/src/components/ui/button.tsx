import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Loader2 } from "lucide-react";
import { Slot } from "radix-ui";
import type * as React from "react";

/**
 * Buttons of DOKUMEN-UI-UX 8.1: one `default` (primary) per screen, `secondary` and `ghost` for the rest,
 * `destructive` only inside a destructive confirmation. Sizes: `sm` 32 px in tables, `default` 40 px,
 * `lg` 48 px on phones and in the warehouse.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-transparent text-[15px] font-semibold whitespace-nowrap transition-colors duration-150 active:scale-[0.98] motion-reduce:transform-none outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm shadow-primary/15 hover:bg-primary-700 hover:shadow-md hover:shadow-primary/15",
        secondary: "border-border-strong bg-surface text-text-900 hover:bg-surface-2",
        outline: "border-border-strong bg-surface text-text-900 hover:bg-surface-2",
        ghost: "text-text-700 hover:bg-surface-2 hover:text-text-900 aria-expanded:bg-surface-2",
        destructive: "bg-danger text-white hover:bg-danger/90 dark:text-canvas",
        link: "h-auto px-0 font-medium text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 gap-1.5 px-3 text-sm [&_svg:not([class*='size-'])]:size-4",
        lg: "h-12 px-5 text-base",
        icon: "size-10",
        "icon-sm": "size-8 [&_svg:not([class*='size-'])]:size-4",
        "icon-lg": "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  loadingLabel,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Shows a spinner in place of the icon, keeps the text, and disables the button (8.1). */
    loading?: boolean;
    loadingLabel?: string;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && !asChild ? (
        <>
          <Loader2 className="animate-spin" aria-hidden />
          {loadingLabel ?? children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
}

export { Button, buttonVariants };
