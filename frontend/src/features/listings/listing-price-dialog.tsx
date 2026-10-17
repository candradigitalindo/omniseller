"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorState, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Listing } from "@/features/products/product-meta";
import { useStores } from "@/features/stores/use-store-modes";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatDateTime, formatRupiah } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";

export function ListingPriceDialog({ listing, onClose }: { listing: Listing; onClose: () => void }) {
  const t = useTranslations("listingPrices");
  const can = useCan();
  const zone = useTimeZone();
  const stores = useStores();
  const client = useQueryClient();
  const [price, setPrice] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [page, setPage] = useState(0);
  const [tab, setTab] = useState<"edit" | "history">("edit");
  const current = useQuery({
    queryKey: ["listing", listing.id],
    queryFn: () => unwrap(api.GET("/v1/listings/{id}", { params: { path: { id: listing.id } } })),
    initialData: listing,
  });
  const history = useQuery({
    queryKey: ["listing-prices", listing.id],
    queryFn: () => unwrap(api.GET("/v1/listings/{id}/price-changes", { params: { path: { id: listing.id } } })),
    refetchInterval: (query) =>
      query.state.data?.items.some((r) => r.status === "queued" || r.status === "processing") ? 2_000 : false,
  });
  const latest = history.data?.items[0];
  const pending = history.data?.items.some((r) => r.status === "queued" || r.status === "processing") ?? false;
  const expected = current.data.originalPrice ?? current.data.price;
  const readOnly = stores.readOnly(listing.storeId);
  const writable =
    can("price:write") &&
    !readOnly &&
    (current.data.status === "active" || (listing.store?.channel === "shopee" && current.data.status === "inactive"));
  useEffect(() => {
    if (latest?.id && (latest.status === "succeeded" || latest.status === "failed")) {
      void client.invalidateQueries({ queryKey: ["listing", listing.id] });
      void client.invalidateQueries({ queryKey: ["listings"] });
    }
  }, [latest?.id, latest?.status, client, listing.id]);
  const change = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/listings/{id}/price-changes", {
          params: { path: { id: listing.id }, header: { "Idempotency-Key": key } },
          body: { price: Number(price), expectedPrice: expected! },
        }),
      ),
    onSuccess: () => {
      setKey(crypto.randomUUID());
      setPage(0);
      setTab("history");
      void client.invalidateQueries({ queryKey: ["listing-prices", listing.id] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const cancel = useMutation({
    mutationFn: (changeId: string) =>
      unwrap(
        api.POST("/v1/listings/{id}/price-changes/cancel", {
          params: { path: { id: listing.id } },
          body: { changeId },
        }),
      ),
    onSuccess: () => {
      toast.success(t("cancelled"));
      setTab("history");
      void history.refetch();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const valid =
    /^\d+$/.test(price) &&
    Number.isSafeInteger(Number(price)) &&
    Number(price) > 0 &&
    Number(price) <= 1_000_000_000_000 &&
    Number(price) !== expected;
  const rows = history.data?.items ?? [];
  const visibleTab = writable ? (pending ? "history" : tab) : "history";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !change.isPending) onClose();
      }}
    >
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <Tabs
          value={visibleTab}
          onValueChange={(value) => setTab(value as "edit" | "history")}
          className="grid min-h-0 gap-3 overflow-y-auto pr-1"
        >
          <div className="rounded-xl bg-surface-2 p-3 text-sm">
            <p className="line-clamp-2 font-medium">{listing.title}</p>
            <p className="text-text-500">
              {listing.variantName ?? listing.sku} · {listing.store?.name}
            </p>
            <p className="mt-2">
              {t("current")} <strong>{expected === null ? t("unknown") : formatRupiah(expected)}</strong>
            </p>
          </div>
          {current.isError ? <ErrorState error={current.error} onRetry={() => current.refetch()} /> : null}
          {writable ? (
            <TabsList aria-label={t("title")} className="grid w-full grid-cols-2 gap-1">
              {(["edit", "history"] as const).map((value) => (
                <TabsTrigger key={value} value={value} disabled={pending && value === "edit"}>
                  {t(value === "edit" ? "editTab" : "historyTab")}
                </TabsTrigger>
              ))}
            </TabsList>
          ) : (
            <p className="text-sm text-text-500">{t(readOnly ? "readOnly" : "cannotEdit")}</p>
          )}
          {writable && visibleTab === "edit" ? (
            <TabsContent value="edit">
              <form
                id="listing-price-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (valid && !pending) change.mutate();
                }}
              >
                <label htmlFor="listing-new-price" className="grid gap-2 text-sm font-medium">
                  {t("newPrice")}
                  <Input
                    id="listing-new-price"
                    aria-label={t("newPrice")}
                    currency
                    value={price}
                    placeholder="0"
                    disabled={pending || change.isPending}
                    onChange={(event) => {
                      setPrice(event.target.value);
                      setKey(crypto.randomUUID());
                    }}
                  />
                </label>
                <p className="mt-2 text-xs text-text-500">{t("hint")}</p>
              </form>
            </TabsContent>
          ) : null}
          {visibleTab === "history" ? (
            <TabsContent value="history">
              <section aria-live="polite" className="grid gap-2">
                {!writable ? <h3 className="text-sm font-semibold">{t("history")}</h3> : null}
                {history.isPending ? (
                  <Skeleton className="h-20" />
                ) : history.isError ? (
                  <ErrorState error={history.error} onRetry={() => history.refetch()} />
                ) : rows.length === 0 ? (
                  <p className="text-sm text-text-500">{t("empty")}</p>
                ) : (
                  rows.slice(page, page + 1).map((row) => (
                    <div key={row.id} className="rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {formatRupiah(row.expectedPrice)} → <strong>{formatRupiah(row.requestedPrice)}</strong>
                        </span>
                        <StatusPill
                          tone={row.status === "succeeded" ? "success" : row.status === "failed" ? "danger" : "neutral"}
                        >
                          {t(`status_${row.status}`)}
                        </StatusPill>
                      </div>
                      <p className="mt-1 text-xs text-text-500">{formatDateTime(row.createdAt, zone)}</p>
                      {row.errorMessage ? <p className="mt-2 text-xs text-text-700">{row.errorMessage}</p> : null}
                      {row.canCancel && can("price:write") ? (
                        <Button
                          className="mt-2"
                          size="sm"
                          variant="secondary"
                          loading={cancel.isPending}
                          onClick={() => cancel.mutate(row.id)}
                        >
                          {t("cancel")}
                        </Button>
                      ) : null}
                    </div>
                  ))
                )}
                {rows.length > 1 ? (
                  <div className="flex items-center justify-between gap-2">
                    <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                      {t("previous")}
                    </Button>
                    <span className="text-xs text-text-500">
                      {page + 1} / {rows.length}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={page + 1 >= rows.length}
                      onClick={() => setPage(page + 1)}
                    >
                      {t("next")}
                    </Button>
                  </div>
                ) : null}
                {pending ? <p className="text-xs text-text-500">{t("waiting")}</p> : null}
              </section>
            </TabsContent>
          ) : null}
        </Tabs>
        <DialogFooter className="flex-row justify-end">
          <Button variant="secondary" onClick={onClose} disabled={change.isPending}>
            {t("close")}
          </Button>
          {writable && visibleTab === "edit" ? (
            <Button
              type="submit"
              form="listing-price-form"
              loading={change.isPending}
              disabled={!valid || pending || !expected || current.isFetching || history.isPending || history.isError}
            >
              {t("submit")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
