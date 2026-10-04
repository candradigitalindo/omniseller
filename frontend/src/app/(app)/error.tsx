"use client";

import { AlertOctagon, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/**
 * A page inside the shell that failed while rendering: the shell stays, the page says so and offers
 * "Coba lagi" (DOKUMEN-UI-UX 9). The message itself is not shown: in production it says nothing useful,
 * and the digest is what support can match with the server's log.
 */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations("common");
  return (
    <div role="alert" className="grid justify-items-center gap-3 px-4 py-16 text-center">
      <AlertOctagon className="size-10 text-danger" aria-hidden />
      <h1 className="text-[22px] font-bold text-text-900">{t("errorTitle")}</h1>
      <p className="max-w-md text-text-500">{t("errorBody")}</p>
      {error.digest ? <p className="font-mono text-[13px] text-text-500">{error.digest}</p> : null}
      <Button variant="secondary" onClick={() => retry()}>
        <RefreshCw aria-hidden />
        {t("retry")}
      </Button>
    </div>
  );
}
