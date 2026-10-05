"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, FolderTree, RefreshCw, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
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
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatRelative } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import type { Category } from "./copy-meta";

/**
 * Chooses a final (leaf) category of one store's marketplace, from the cache the worker fills (backend
 * 8.25): browse from the top, or search the full path. Categories the shop may not sell in are shown but
 * cannot be chosen. An empty cache can be read from the marketplace at most every 10 minutes.
 */
export function CategoryPicker({
  open,
  storeId,
  title,
  busy,
  onPick,
  onClose,
}: {
  open: boolean;
  storeId: string;
  title: string;
  busy?: boolean;
  onPick: (category: Category) => void;
  onClose: () => void;
}) {
  const t = useTranslations("listingCopy");
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("pickerBody")}</DialogDescription>
        </DialogHeader>
        {open ? <PickerBody storeId={storeId} busy={busy ?? false} onPick={onPick} /> : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PickerBody({
  storeId,
  busy,
  onPick,
}: {
  storeId: string;
  busy: boolean;
  onPick: (category: Category) => void;
}) {
  const t = useTranslations("listingCopy");
  const tz = useTimeZone();
  const can = useCan();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [trail, setTrail] = useState<Category[]>([]);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);
  const parent = trail.at(-1) ?? null;
  const searching = term.length >= 2;
  const list = useQuery({
    queryKey: ["categories", storeId, searching ? `q:${term}` : `p:${parent?.categoryId ?? ""}`],
    queryFn: () =>
      unwrap(
        api.GET("/v1/stores/{id}/categories", {
          params: {
            path: { id: storeId },
            query: searching
              ? { q: term, leafOnly: "true", limit: 50 }
              : { ...(parent ? { parentId: parent.categoryId } : {}), limit: 200 },
          },
        }),
      ),
    // after asking for the list, look again until the worker has filled it
    refetchInterval: (query) => (waiting && (query.state.data?.total ?? 0) === 0 ? 3_000 : false),
  });
  const refresh = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/stores/{id}/categories/refresh", { params: { path: { id: storeId } } })),
    onSuccess: () => setWaiting(true),
  });
  const data = list.data;
  const empty = data && data.total === 0;

  return (
    <div className="grid gap-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-500"
          aria-hidden
        />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("categorySearch")}
          aria-label={t("categorySearch")}
          className="pl-9"
        />
      </div>
      {!searching ? (
        <nav aria-label={t("categoryTrail")} className="flex flex-wrap items-center gap-1 text-sm">
          <button
            type="button"
            className="rounded px-1 text-primary hover:underline disabled:text-text-700 disabled:no-underline"
            disabled={trail.length === 0}
            onClick={() => setTrail([])}
          >
            {t("categoryTop")}
          </button>
          {trail.map((c, i) => (
            <span key={c.categoryId} className="flex items-center gap-1">
              <ChevronRight className="size-3.5 text-text-500" aria-hidden />
              <button
                type="button"
                className="rounded px-1 text-primary hover:underline disabled:text-text-700 disabled:no-underline"
                disabled={i === trail.length - 1}
                onClick={() => setTrail(trail.slice(0, i + 1))}
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>
      ) : null}

      {list.isPending ? (
        <div className="grid gap-2" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : list.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(list.error)}
        </p>
      ) : empty && !searching && !parent ? (
        <div className="grid justify-items-start gap-2 rounded-lg bg-surface-2 p-4 text-sm text-text-700">
          <FolderTree className="size-5 text-text-500" aria-hidden />
          <p>{waiting ? t("categoriesLoading") : t("categoriesEmpty")}</p>
          {can("catalog:write") && !waiting ? (
            <Button variant="secondary" size="sm" loading={refresh.isPending} onClick={() => refresh.mutate()}>
              <RefreshCw aria-hidden />
              {t("categoriesRead")}
            </Button>
          ) : null}
          {refresh.isError ? <p className="text-danger">{errorMessage(refresh.error)}</p> : null}
        </div>
      ) : data && data.items.length === 0 ? (
        <p className="py-4 text-center text-sm text-text-500">{t("categoriesNone")}</p>
      ) : (
        <ul className="grid max-h-80 gap-0.5 overflow-y-auto" aria-label={t("categories")}>
          {data?.items.map((c) => (
            <li key={c.categoryId}>
              <button
                type="button"
                disabled={(c.isLeaf && !c.permitted) || busy}
                onClick={() => (c.isLeaf ? onPick(c) : setTrail([...trail, c]))}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="grid min-w-0">
                  <span className="truncate text-text-900">{searching ? c.path : c.name}</span>
                  {c.isLeaf && !c.permitted ? (
                    <span className="text-[13px] text-text-500">{t("categoryNotPermitted")}</span>
                  ) : null}
                </span>
                {c.isLeaf ? (
                  <span className="shrink-0 text-[13px] font-medium text-primary">{t("choose")}</span>
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-text-500" aria-hidden />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {data?.refreshedAt ? (
        <p className="text-[13px] text-text-500">
          {t("categoriesReadAt", { at: formatRelative(data.refreshedAt, tz) })}
        </p>
      ) : null}
    </div>
  );
}
