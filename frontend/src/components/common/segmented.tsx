"use client";

import { cn } from "cn";
import { useId } from "react";

/**
 * One choice out of a few, side by side (the dashboard's range): native radio buttons, not tabs, since no
 * panel belongs to each option. The browser gives the arrow keys and the announcements.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  block = false,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  /** full width with equal options whose words may wrap, for long labels inside a form */
  block?: boolean;
}) {
  const name = useId();
  return (
    <fieldset
      className={cn(
        "rounded-lg bg-surface-2 p-[3px] ring-1 ring-border ring-inset",
        block ? "grid w-full auto-cols-fr grid-flow-col" : "inline-flex",
      )}
    >
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <label key={o.value} className="relative">
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
            className="peer sr-only"
          />
          <span
            className={cn(
              "inline-flex cursor-pointer items-center rounded-md px-3 text-sm font-medium text-text-700 hover:text-text-900 peer-checked:bg-surface peer-checked:text-text-900 peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
              block ? "min-h-8 w-full justify-center py-1.5 text-center" : "h-8 whitespace-nowrap",
            )}
          >
            {o.label}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
