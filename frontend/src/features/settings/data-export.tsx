"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileArchive } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { EmptyState, ErrorState, PageHeader, StatusPill, type Tone } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";

type DataExport = components["schemas"]["DataExportDto_Output"];

const TONE: Record<DataExport["status"], Tone> = {
  queued: "neutral",
  running: "info",
  ready: "success",
  failed: "danger",
};

/** "1,2 MB", "840 KB". */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024)
    return `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MB`;
  return `${formatNumber(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

/**
 * Ekspor Data (FR-MIG-09, backend 8.18): every table of the business as CSV in one ZIP, at any time and free,
 * so the data is the seller's to take along. Prepared by the worker; the file is kept for a few days.
 */
/**
 * `embedded`: part of another page (L54 "Akun ditutup"), with its title as a section heading, not the
 * page's; `note` adds a sentence to the description.
 */
export function DataExportView({ embedded = false, note }: { embedded?: boolean; note?: string | undefined } = {}) {
  const t = useTranslations("dataExport");
  const tz = useTimeZone();
  const can = useCan();
  const queryClient = useQueryClient();
  const allowed = can("data:export");
  const list = useQuery({
    queryKey: ["exports"],
    queryFn: () => unwrap(api.GET("/v1/exports")),
    enabled: allowed,
    refetchInterval: (q) =>
      q.state.data?.items.some((e) => e.status === "queued" || e.status === "running") ? 3_000 : false,
  });
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/exports")),
    onSuccess: () => {
      toast.success(t("started"));
      void queryClient.invalidateQueries({ queryKey: ["exports"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!allowed) return <PageHeader title={t("title")} description={t("noAccess")} />;
  const busy = list.data?.items.some((e) => e.status === "queued" || e.status === "running") ?? false;
  const start = (
    <Button loading={create.isPending} disabled={busy} onClick={() => create.mutate()}>
      <FileArchive aria-hidden />
      {t("create")}
    </Button>
  );
  const Wrapper = embedded ? "section" : "div";
  return (
    <Wrapper className="grid gap-3" {...(embedded ? { "aria-labelledby": "data-export-title" } : {})}>
      {embedded ? (
        <div className="grid gap-3 sm:flex sm:items-start sm:justify-between">
          <div className="grid gap-1">
            <h2 id="data-export-title" className="text-lg font-semibold text-text-900">
              {t("title")}
            </h2>
            <p className="text-sm text-text-500">
              {t("description")}
              {note ? ` ${note}` : null}
            </p>
          </div>
          {start}
        </div>
      ) : (
        <PageHeader title={t("title")} description={t("description")} actions={start} />
      )}
      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.isError ? (
        <Card>
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        </Card>
      ) : list.data.items.length === 0 ? (
        <Card>
          <EmptyState icon={FileArchive} title={t("empty")} body={t("emptyBody")} />
        </Card>
      ) : (
        <ul className="grid gap-3">
          {list.data.items.map((e) => (
            <li key={e.id}>
              <Card size="sm">
                <CardContent className="grid gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-text-900">
                      {t("madeAt", { at: formatDateTime(e.createdAt, tz) })}
                    </span>
                    <StatusPill tone={e.expired ? "neutral" : TONE[e.status]}>
                      {e.expired ? t("expired") : t(`status_${e.status}`)}
                    </StatusPill>
                  </div>
                  {e.status === "ready" ? (
                    <p className="text-[13px] text-text-500">
                      {[
                        t("files", { count: e.files.length }),
                        e.sizeBytes !== null ? formatSize(e.sizeBytes) : null,
                        e.expiresAt && !e.expired ? t("expiresAt", { at: formatDateTime(e.expiresAt, tz) }) : null,
                        t("downloads", { count: e.downloadCount }),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  ) : null}
                  {e.error ? <p className="text-sm text-danger">{e.error}</p> : null}
                  {e.files.length > 0 ? (
                    <details className="text-[13px] text-text-700">
                      <summary className="cursor-pointer">{t("whatsInside")}</summary>
                      <ul className="mt-1 grid gap-0.5 pl-4">
                        {e.files.map((f) => (
                          <li key={f.name} className="list-disc">
                            <span className="font-mono">{f.name}</span> · {t("rows", { count: f.rows })}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {e.downloadUrl ? (
                    <Button asChild size="sm" className="justify-self-start">
                      <a href={e.downloadUrl} download>
                        <Download aria-hidden />
                        {t("download")}
                      </a>
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </Wrapper>
  );
}
