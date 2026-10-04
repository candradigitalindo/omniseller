import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

/**
 * A form field as DOKUMEN-UI-UX 8.2 lays it out: the label above, a hint below, and the error in red with
 * an icon and a plain sentence in place of the hint. The control gets `id`, `aria-invalid`, and
 * `aria-describedby` from the caller (`fieldProps`).
 */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-sm font-medium text-text-700">
        {label}
      </Label>
      {children}
      {error ? (
        <p id={`${id}-message`} role="alert" className="flex items-start gap-1.5 text-sm text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-message`} className="text-sm text-text-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Accessibility wiring between a control and its Field. */
export function fieldProps(id: string, error: string | undefined, hasHint = false) {
  return {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error || hasHint ? `${id}-message` : undefined,
  } as const;
}
