"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Copy as CopyIcon, ListChecks } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ChannelIcon } from "@/components/common/channel";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatNumber, formatRelative } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import { CopyDialog } from "./copy-dialog";
import { COPY_TONE, type Copy, copyProgress } from "./copy-meta";
import { DraftsView } from "./drafts-view";

const TABS = ["salinan", "draf"] as const;
type Tab = (typeof TABS)[number];

/**
 * Salin Listing (FR-PRD-13, backend 8.25; DOKUMEN-UI-UX L15a): copies of the seller's listings from one store
 * to others, each turned into drafts by the worker, reviewed here, and published to the marketplace.
 */
export function CopiesView() {
  const t = useTranslations("listingCopy");
  const can = useCan();
  const { params, set } = useUrlParams();
  const [copying, setCopying] = useState(false);
  const tab: Tab = TABS.find((x) => x === params.get("tab")) ?? "salinan";
  if (!can("catalog:read")) return <PageHeader title={t("title")} description={t("noAccess")} />;
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          can("catalog:write") ? (
            <Button onClick={() => setCopying(true)}>
              <CopyIcon aria-hidden />
              {t("copyTitle")}
            </Button>
          ) : null
        }
      />
      <Tabs value={tab} onValueChange={(v) => set({ tab: v === "salinan" ? null : v, copy: null })}>
        <TabsList
          variant="line"
          className="mb-4 w-full max-w-full justify-start overflow-x-auto border-b"
          aria-label={t("tabs")}
        >
          {TABS.map((x) => (
            <TabsTrigger key={x} value={x} className="flex-none px-3 text-[15px]">
              {t(`tab_${x}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="salinan">
          <CopiesList onReview={(id) => set({ tab: "draf", copy: id, view: null })} onCopy={() => setCopying(true)} />
        </TabsContent>
        <TabsContent value="draf">
          <DraftsView />
        </TabsContent>
      </Tabs>
      <CopyDialog open={copying} onClose={() => setCopying(false)} />
    </>
  );
}

function CopiesList({ onReview, onCopy }: { onReview: (copyId: string) => void; onCopy: () => void }) {
  const t = useTranslations("listingCopy");
  const can = useCan();
  const copies = useQuery({
    queryKey: ["listing-copies"],
    queryFn: () => unwrap(api.GET("/v1/listing-copies", { params: { query: { limit: 50 } } })),
    // the worker prepares items in batches; follow it until every copy is done
    refetchInterval: (q) => (q.state.data?.items.some((c) => c.status === "preparing") ? 3_000 : false),
  });
  if (copies.isPending) {
    return (
      <div className="grid gap-3" aria-busy>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }
  if (copies.isError) {
    return (
      <Card>
        <ErrorState error={copies.error} onRetry={() => copies.refetch()} />
      </Card>
    );
  }
  if (copies.data.items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={CopyIcon}
          title={t("empty")}
          body={t("emptyBody")}
          action={
            can("catalog:write") ? (
              <Button onClick={onCopy}>
                <CopyIcon aria-hidden />
                {t("copyTitle")}
              </Button>
            ) : null
          }
        />
      </Card>
    );
  }
  return (
    <ul className="grid gap-3">
      {copies.data.items.map((c) => (
        <li key={c.id}>
          <CopyCard copy={c} onReview={() => onReview(c.id)} />
        </li>
      ))}
    </ul>
  );
}

function CopyCard({ copy: c, onReview }: { copy: Copy; onReview: () => void }) {
  const t = useTranslations("listingCopy");
  const tz = useTimeZone();
  const can = useCan();
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/listing-copies/{id}/cancel", { params: { path: { id: c.id } } })),
    onSuccess: () => {
      toast.success(t("cancelled"));
      void queryClient.invalidateQueries({ queryKey: ["listing-copies"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const drafts = c.drafts as Record<string, number>;
  const draftTotal = Object.values(drafts).reduce((a, b) => a + b, 0);
  return (
    <Card size="sm">
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-900">
            <ChannelIcon channel={c.sourceStore.channel} decorative />
            {c.sourceStore.name}
            <ArrowRight className="size-4 text-text-500" aria-hidden />
            <span className="sr-only">{t("to")}</span>
            <ChannelIcon channel={c.targetStore.channel} decorative />
            {c.targetStore.name}
          </span>
          <StatusPill tone={COPY_TONE[c.status]}>{t(`copyStatus_${c.status}`)}</StatusPill>
        </div>
        <p className="text-[13px] text-text-500">
          {c.scope === "store" ? t("scopeStoreShort") : t("scopeItemsShort", { count: c.itemsTotal })}
          {c.priceChangePercent !== 0 ? ` · ${t("priceChanged", { percent: c.priceChangePercent })}` : ""}
          {` · ${formatRelative(c.createdAt, tz)}`}
        </p>
        {c.status === "preparing" ? (
          <div className="grid gap-1">
            <Progress value={copyProgress(c)} aria-label={t("progress")} />
            <span className="text-[13px] text-text-700">
              {t("preparingCount", { done: c.itemsDrafted + c.itemsSkipped + c.itemsFailed, total: c.itemsTotal })}
            </span>
          </div>
        ) : null}
        <p className="text-sm text-text-700">
          {t("itemCounts", { drafted: c.itemsDrafted, skipped: c.itemsSkipped, failed: c.itemsFailed })}
        </p>
        {draftTotal > 0 ? (
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-text-500">
            {(["draft", "publishing", "published", "failed"] as const)
              .filter((s) => (drafts[s] ?? 0) > 0)
              .map((s) => (
                <span key={s}>{t(`draftCount_${s}`, { count: formatNumber(drafts[s] ?? 0) })}</span>
              ))}
          </p>
        ) : null}
        {c.error ? <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{c.error}</p> : null}
        {c.failures.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-danger">{t("failures", { count: c.failures.length })}</summary>
            <ul className="mt-2 grid gap-1 pl-4 text-text-700">
              {c.failures.map((f) => (
                <li key={f.externalItemId} className="list-disc">
                  <span className="font-medium">{f.title ?? f.externalItemId}</span>: {f.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {draftTotal > 0 ? (
            <Button size="sm" onClick={onReview}>
              <ListChecks aria-hidden />
              {t("review")}
            </Button>
          ) : null}
          {c.status === "preparing" && can("catalog:write") ? (
            <Button size="sm" variant="secondary" loading={cancel.isPending} onClick={() => cancel.mutate()}>
              {t("cancelCopy")}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
