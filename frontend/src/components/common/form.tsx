"use client";

import { CircleAlert } from "lucide-react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { ApiError, errorMessage } from "@/lib/api/errors";

/**
 * Puts the api's field errors (`errors[].path`) under the fields of the form; anything else becomes the
 * form's banner (`root`).
 */
export function showServerErrors<T extends FieldValues, C = unknown, O extends FieldValues = T>(
  form: UseFormReturn<T, C, O>,
  error: unknown,
): void {
  const fields = Object.keys(form.getValues());
  let placed = false;
  if (error instanceof ApiError) {
    for (const issue of error.errors) {
      if (fields.includes(issue.path)) {
        form.setError(issue.path as Path<T>, { type: "server", message: issue.message });
        placed = true;
      }
    }
  }
  if (!placed) form.setError("root", { type: "server", message: errorMessage(error) });
}

/** The red banner above a form (DOKUMEN-UI-UX 9). */
export function FormBanner({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  );
}
