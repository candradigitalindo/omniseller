"use client";

import { cn } from "cn";
import type * as React from "react";

/**
 * `scrollLabel`: for a table without links or buttons that can scroll sideways (a matrix on a phone). Its
 * container becomes a named region the keyboard can focus and scroll (WCAG 2.1.1; axe
 * `scrollable-region-focusable`); tables with controls are reachable through them already.
 */
function Table({ className, scrollLabel, ...props }: React.ComponentProps<"table"> & { scrollLabel?: string }) {
  if (scrollLabel) {
    return (
      <section
        data-slot="table-container"
        aria-label={scrollLabel}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to be scrolled by keyboard
        tabIndex={0}
        className="relative w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-primary"
      >
        <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
      </section>
    );
  }
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption data-slot="table-caption" className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
  );
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
