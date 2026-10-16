"use client";

import { useIsFetching, useIsMutating } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export function LoadingState({
  compact = false,
  saving = false,
  slow = false,
}: {
  compact?: boolean;
  saving?: boolean;
  slow?: boolean;
}) {
  const t = useTranslations("common");
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        compact
          ? "flex items-center gap-3 rounded-2xl border bg-surface px-4 py-3 text-sm shadow-float"
          : "grid justify-items-center gap-3 px-5 py-10 text-center"
      }
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary-50 text-primary">
        <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" aria-hidden />
      </span>
      <div className="grid gap-1">
        <p className="font-medium text-text-900">{t(saving ? "savingData" : "loadingData")}</p>
        <p className="max-w-sm text-xs leading-relaxed text-text-500">
          {t(slow ? "takingLonger" : saving ? "savingHint" : "loadingHint")}
        </p>
      </div>
    </div>
  );
}

/** Delayed feedback for real requests; no fabricated percentages or artificial minimum duration. */
export function RequestActivity() {
  const fetching = useIsFetching();
  const mutating = useIsMutating();
  const busy = fetching + mutating > 0;
  const [visible, setVisible] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setVisible(false);
      setSlow(false);
      return;
    }
    const show = setTimeout(() => setVisible(true), 450);
    const delayed = setTimeout(() => setSlow(true), 8000);
    return () => {
      clearTimeout(show);
      clearTimeout(delayed);
    };
  }, [busy]);
  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed top-[max(0.75rem,env(safe-area-inset-top))] right-3 left-3 z-[100] flex justify-center sm:left-auto sm:max-w-sm">
      <LoadingState compact saving={mutating > 0} slow={slow} />
    </div>
  );
}
