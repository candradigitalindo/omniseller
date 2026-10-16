import { cn } from "cn";
import type * as React from "react";

/**
 * Cards of DOKUMEN-UI-UX 6.4: white surface, 10 px radius, a hairline border and a soft shadow; 20 px
 * padding from tablets up, 16 px on phones.
 */
function Card({ className, size = "default", ...props }: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-2xl border border-border bg-card py-(--card-spacing) text-card-foreground shadow-card [--card-spacing:--spacing(4)] md:[--card-spacing:--spacing(5)] has-data-[slot=card-footer]:pb-0 data-[size=sm]:[--card-spacing:--spacing(3)]",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 px-(--card-spacing) @md/card-header:has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className,
      )}
      {...props}
    />
  );
}

/** H2 of the UI document: 18 px, semibold, Plus Jakarta Sans. */
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("font-heading text-lg leading-snug font-semibold text-text-900", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-description" className={cn("text-sm text-text-500", className)} {...props} />;
}

/** Beside the title in a wide card; below the description in a narrow one (a phone), so neither is squeezed. */
function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "mt-2 self-start justify-self-start @md/card-header:col-start-2 @md/card-header:row-span-2 @md/card-header:row-start-1 @md/card-header:mt-0 @md/card-header:justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-(--card-spacing)", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center border-t bg-surface-2 p-(--card-spacing)", className)}
      {...props}
    />
  );
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
