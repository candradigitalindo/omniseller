"use client";

import { CircleAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";
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
export function FormBanner({ message, onDismiss }: { message: string | undefined; onDismiss?: () => void }) {
  const t = useTranslations("common");
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-2xl border border-danger/15 bg-danger-soft/70 p-4 text-sm text-danger"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface/70">
        <CircleAlert className="size-4" aria-hidden />
      </span>
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="font-semibold">{t("alertTitle")}</p>
        <p className="leading-relaxed break-words">{message}</p>
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("dismissAlert")}
          className="-mt-1 -mr-1 grid size-8 shrink-0 place-items-center rounded-lg outline-none hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-danger"
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
