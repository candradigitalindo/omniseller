"use client";
import { CheckCircle2, LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import type { InboxReceipt } from "./contracts";
export function InboxStatus({ status, loading }: { status?: InboxReceipt["status"]; loading?: boolean }) {
  const t = useTranslations("commerceInbox");
  if (loading || status === "queued" || status === "running")
    return (
      <p role="status" className="flex items-start gap-2 text-sm text-primary">
        <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden />
        {t(status === "running" ? "running" : "loading")}
      </p>
    );
  if (status === "uncertain")
    return (
      <p role="alert" className="rounded-xl bg-warning-soft p-3 text-sm text-warning">
        {t("uncertain")}
      </p>
    );
  if (status === "failed")
    return (
      <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
        {t("failed")}
      </p>
    );
  if (status === "succeeded")
    return (
      <p role="status" className="flex items-start gap-2 rounded-xl bg-success-soft p-3 text-sm text-success">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
        {t("accepted")}
      </p>
    );
  return null;
}
