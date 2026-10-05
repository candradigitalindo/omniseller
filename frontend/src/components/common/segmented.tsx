"use client";

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
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  const name = useId();
  return (
    <fieldset className="inline-flex rounded-lg bg-surface-2 p-[3px] ring-1 ring-border ring-inset">
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
          <span className="inline-flex h-8 cursor-pointer items-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-text-700 hover:text-text-900 peer-checked:bg-surface peer-checked:text-text-900 peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
            {o.label}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
