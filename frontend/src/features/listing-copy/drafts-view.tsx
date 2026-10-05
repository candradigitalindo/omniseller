"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { FolderTree, ListChecks, Rocket, Search, Tags, Trash2, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChannelIcon } from "@/components/common/channel";
import { EmptyState, ErrorState, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useStores } from "@/features/stores/use-store-modes";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatNumber, formatRupiah } from "@/lib/format";
import { useCan } from "@/lib/session";
import { AttributeInput } from "./attribute-input";
import { CategoryPicker } from "./category-picker";
import {
  type AttributeValue,
  attributeValues,
  DRAFT_TAB_QUERY,
  DRAFT_TABS,
  DRAFT_TONE,
  type DraftItem,
  type DraftQuery,
  draftTabOf,
  editable,
  priceRange,
  publishable,
  sortedAttributes,
  working,
} from "./copy-meta";

const PAGE = 50;
const ALL = "all";

/** The drafts to review (backend 8.25 step 3): what to fix, what can be published, what failed. */
export function DraftsView() {
  const t = useTranslations("listingCopy");
  const tCommon = useTranslations("common");
  const { params, set } = useUrlParams();
  const { byId } = useStores();
  const tab = draftTabOf(params.get("view"));
  const copyId = params.get("copy");
  const storeId = params.get("store");
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  useEffect(() => {
    if (search.trim() === q) return;
    const id = setTimeout(() => set({ q: search.trim() || null }), 300);
    return () => clearTimeout(id);
  }, [search, q, set]);
  const stores = [...byId.values()].filter((s) => s.channel !== "manual");
  const query: DraftQuery = {
    ...DRAFT_TAB_QUERY[tab],
    ...(copyId ? { copyId } : {}),
    ...(storeId ? { targetStoreId: storeId } : {}),
    ...(q ? { q } : {}),
  };

  return (
    <div className="grid gap-3">
      <fieldset className="-mx-4 flex min-w-0 gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label={t("queues")}>
        {DRAFT_TABS.map((x) => (
          <Button
            key={x}
            size="sm"
            variant={tab === x ? "default" : "ghost"}
            aria-pressed={tab === x}
            onClick={() => set({ view: x === "all" ? null : x })}
          >
            {t(`queue_${x}`)}
          </Button>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 md:max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-500"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("draftSearch")}
            aria-label={tCommon("search")}
            className="pl-9"
          />
        </div>
        {stores.length > 1 ? (
          <Select value={storeId ?? ALL} onValueChange={(v) => set({ store: v === ALL ? null : v })}>
            <SelectTrigger className="h-10 w-56" aria-label={t("targetStore")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("allTargets")}</SelectItem>
              {stores.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  <ChannelIcon channel={s.channel} decorative />
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {copyId ? (
          <span className="inline-flex h-10 items-center gap-1.5 rounded-full bg-primary-100 px-3.5 text-sm font-medium text-primary-600">
            {t("fromCopy")}
            <button
              type="button"
              className="rounded-full p-0.5 hover:bg-primary-50"
              aria-label={t("clearCopy")}
              onClick={() => set({ copy: null })}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        ) : null}
      </div>
      {/* a new filter starts with nothing selected */}
      <DraftsTable key={JSON.stringify(query)} query={query} />
    </div>
  );
}

function DraftsTable({ query }: { query: DraftQuery }) {
  const t = useTranslations("listingCopy");
  const tCommon = useTranslations("common");
  const can = useCan();
  const queryClient = useQueryClient();
  const { byId } = useStores();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [action, setAction] = useState<"category" | "attribute" | "delete" | null>(null);
  const [refused, setRefused] = useState<{ title: string; message: string }[]>([]);

  const list = useInfiniteQuery({
    queryKey: ["listing-drafts", query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/listing-drafts", {
          params: { query: { ...query, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    // drafts being prepared or published change on their own; follow them
    refetchInterval: (q) => (q.state.data?.pages.some((p) => p.items.some(working)) ? 3_000 : false),
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const chosen = rows.filter((r) => selected.has(r.id));
  const store = chosen[0]?.targetStoreId;
  const oneStore = chosen.length > 0 && chosen.every((r) => r.targetStoreId === store);
  const ready = chosen.filter(publishable);
  const changeable = chosen.filter(editable);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["listing-drafts"] });

  const publish = useMutation({
    mutationFn: (ids: string[]) => unwrap(api.POST("/v1/listing-drafts/publish", { body: { draftIds: ids } })),
    onSuccess: (r) => {
      const titles = new Map(rows.map((d) => [d.id, d.title]));
      setRefused(r.refused.map((x) => ({ title: titles.get(x.draftId) ?? x.draftId, message: x.message })));
      if (r.queued.length > 0) toast.success(t("publishQueued", { count: r.queued.length }));
      setSelected(new Set());
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const category = useMutation({
    mutationFn: (categoryId: string) =>
      unwrap(api.POST("/v1/listing-drafts/category", { body: { draftIds: changeable.map((d) => d.id), categoryId } })),
    onSuccess: (r) => {
      toast.success(t("categoryChanged", { count: r.updated }));
      setAction(null);
      setSelected(new Set());
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: async (ids: string[]) => {
      // one by one: each draft is its own row, and a failure leaves the others done
      let done = 0;
      for (const id of ids) {
        await unwrap(api.DELETE("/v1/listing-drafts/{id}", { params: { path: { id } } }));
        done++;
      }
      return done;
    },
    onSuccess: (done) => {
      toast.success(t("deleted", { count: done }));
      setAction(null);
      setSelected(new Set());
      refresh();
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      refresh();
    },
  });

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <>
      {chosen.length > 0 ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-[10px] border bg-surface p-2 shadow-card"
          role="toolbar"
          aria-label={t("bulkActions")}
        >
          <span className="px-2 text-sm font-medium text-text-900">{t("selected", { count: chosen.length })}</span>
          {can("catalog:publish") ? (
            <Button
              size="sm"
              disabled={ready.length === 0}
              loading={publish.isPending}
              onClick={() => publish.mutate(ready.map((d) => d.id))}
            >
              <Rocket aria-hidden />
              {t("publishCount", { count: ready.length })}
            </Button>
          ) : null}
          {can("catalog:write") ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={!oneStore || changeable.length === 0}
                onClick={() => setAction("category")}
              >
                <FolderTree aria-hidden />
                {t("changeCategory")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!oneStore || changeable.length === 0}
                onClick={() => setAction("attribute")}
              >
                <Tags aria-hidden />
                {t("setAttribute")}
              </Button>
              <Button size="sm" variant="ghost" disabled={changeable.length === 0} onClick={() => setAction("delete")}>
                <Trash2 aria-hidden />
                {t("delete")}
              </Button>
            </>
          ) : null}
          {!oneStore ? <span className="px-2 text-[13px] text-text-500">{t("oneStoreOnly")}</span> : null}
        </div>
      ) : null}
      {refused.length > 0 ? (
        <div role="alert" className="grid gap-1 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
          <p className="font-medium">{t("refused", { count: refused.length })}</p>
          <ul className="list-disc pl-5">
            {refused.map((r) => (
              <li key={r.title}>
                {r.title}: {r.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card className="gap-0 py-0">
        {list.isPending ? (
          <div className="grid gap-2 p-4" aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={ListChecks} title={t("draftsEmpty")} body={t("draftsEmptyBody")} />
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader className="bg-surface-2">
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allOn}
                        onCheckedChange={(on) => setSelected(on ? new Set(rows.map((r) => r.id)) : new Set())}
                        aria-label={t("selectAll")}
                      />
                    </TableHead>
                    <TableHead className="min-w-72">{t("colProduct")}</TableHead>
                    <TableHead>{t("colTarget")}</TableHead>
                    <TableHead className="text-right">{t("colVariants")}</TableHead>
                    <TableHead className="text-right">{t("colPrice")}</TableHead>
                    <TableHead>{t("colProblems")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((d) => {
                    const target = byId.get(d.targetStoreId);
                    return (
                      <TableRow key={d.id} data-state={selected.has(d.id) ? "selected" : undefined}>
                        <TableCell>
                          <Checkbox
                            checked={selected.has(d.id)}
                            onCheckedChange={(on) => toggle(d.id, on === true)}
                            aria-label={t("select", { title: d.title })}
                          />
                        </TableCell>
                        <TableCell className="max-w-96">
                          <DraftTitle draft={d} />
                        </TableCell>
                        <TableCell>
                          {target ? (
                            <span className="flex items-center gap-1.5 text-sm text-text-700">
                              <ChannelIcon channel={target.channel} decorative />
                              {target.name}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="tabular text-right">{formatNumber(d.variantCount)}</TableCell>
                        <TableCell className="tabular text-right whitespace-nowrap">
                          {priceRange(d.priceMin, d.priceMax, formatRupiah)}
                        </TableCell>
                        <TableCell>
                          <Problems draft={d} />
                        </TableCell>
                        <TableCell>
                          <StatusPill tone={DRAFT_TONE[d.status]}>{t(`draftStatus_${d.status}`)}</StatusPill>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <ul className="divide-y md:hidden">
              {rows.map((d) => (
                <li key={d.id} className="flex gap-3 p-4">
                  <Checkbox
                    className="mt-1"
                    checked={selected.has(d.id)}
                    onCheckedChange={(on) => toggle(d.id, on === true)}
                    aria-label={t("select", { title: d.title })}
                  />
                  <div className="grid min-w-0 flex-1 gap-1.5">
                    <DraftTitle draft={d} />
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={DRAFT_TONE[d.status]}>{t(`draftStatus_${d.status}`)}</StatusPill>
                      <Problems draft={d} />
                    </div>
                    <span className="text-[13px] text-text-500">
                      {t("variantsPrice", {
                        count: d.variantCount,
                        price: priceRange(d.priceMin, d.priceMax, formatRupiah),
                      })}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            {list.hasNextPage ? (
              <div className="border-t p-3 text-center">
                <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                  {tCommon("loadMore")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>

      {store && oneStore ? (
        <CategoryPicker
          open={action === "category"}
          storeId={store}
          title={t("changeCategoryOf", { count: changeable.length })}
          busy={category.isPending}
          onPick={(c) => category.mutate(c.categoryId)}
          onClose={() => setAction(null)}
        />
      ) : null}
      {store && oneStore && action === "attribute" ? (
        <BulkAttributeDialog
          storeId={store}
          drafts={changeable}
          onDone={() => {
            setAction(null);
            setSelected(new Set());
            refresh();
          }}
          onClose={() => setAction(null)}
        />
      ) : null}
      <Dialog open={action === "delete"} onOpenChange={(v) => !v && setAction(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("deleteTitle", { count: changeable.length })}</DialogTitle>
            <DialogDescription>{t("deleteBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setAction(null)}>
              {tCommon("cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() => remove.mutate(changeable.map((d) => d.id))}
            >
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DraftTitle({ draft: d }: { draft: DraftItem }) {
  const t = useTranslations("listingCopy");
  return (
    <div className="flex min-w-0 gap-3">
      {d.imageUrl ? (
        <Image
          src={d.imageUrl}
          alt=""
          width={40}
          height={40}
          unoptimized
          className="size-10 shrink-0 rounded-md border object-cover"
        />
      ) : (
        <span className="size-10 shrink-0 rounded-md bg-surface-2" aria-hidden />
      )}
      <div className="grid min-w-0 gap-0.5">
        <Link
          href={`/listing/salin/draf/${d.id}`}
          className="truncate text-sm font-medium text-primary hover:underline"
          title={d.title}
        >
          {d.title}
        </Link>
        <span className={cn("truncate text-[13px]", d.categoryPath ? "text-text-500" : "text-warning")}>
          {d.categoryPath ?? t("noCategory")}
        </span>
        {d.status === "failed" && d.error ? <span className="text-[13px] text-danger">{d.error}</span> : null}
      </div>
    </div>
  );
}

function Problems({ draft: d }: { draft: DraftItem }) {
  const t = useTranslations("listingCopy");
  if (d.status === "published" || d.status === "preparing") return null;
  if (d.blockingProblems === 0 && d.warnings === 0) return <StatusPill tone="success">{t("noProblems")}</StatusPill>;
  return (
    <span className="flex flex-wrap gap-1">
      {d.blockingProblems > 0 ? (
        <StatusPill tone="danger">{t("blockingCount", { count: d.blockingProblems })}</StatusPill>
      ) : null}
      {d.warnings > 0 ? <StatusPill tone="warning">{t("warningCount", { count: d.warnings })}</StatusPill> : null}
    </span>
  );
}

/**
 * One attribute for many drafts of one store ("Barang Impor" for a whole store): the attribute list comes
 * from the first draft's category; drafts in a category without it are skipped and named.
 */
function BulkAttributeDialog({
  storeId,
  drafts,
  onDone,
  onClose,
}: {
  storeId: string;
  drafts: DraftItem[];
  onDone: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("listingCopy");
  const tCommon = useTranslations("common");
  const first = drafts[0];
  const [attributeId, setAttributeId] = useState("");
  const [value, setValue] = useState<AttributeValue>({ valueIds: [], text: "", unit: "" });
  const [skipped, setSkipped] = useState<{ title: string; reason: string }[] | null>(null);
  const detail = useQuery({
    queryKey: ["listing-drafts", "detail", first?.id],
    queryFn: () => unwrap(api.GET("/v1/listing-drafts/{id}", { params: { path: { id: first?.id ?? "" } } })),
    enabled: !!first,
  });
  const categoryId = detail.data?.externalCategoryId ?? null;
  const rules = useQuery({
    queryKey: ["categories", storeId, "detail", categoryId],
    queryFn: () =>
      unwrap(
        api.GET("/v1/stores/{id}/categories/{categoryId}", {
          params: { path: { id: storeId, categoryId: categoryId ?? "" } },
        }),
      ),
    enabled: categoryId !== null,
    refetchInterval: (q) => (q.state.data?.rulesPending ? 2_000 : false),
  });
  const attributes = rules.data?.rules ? sortedAttributes(rules.data.rules) : [];
  const attribute = attributes.find((a) => a.attributeId === attributeId);
  const apply = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/listing-drafts/attributes", {
          body: { draftIds: drafts.map((d) => d.id), attributeId, values: attributeValues(value) },
        }),
      ),
    onSuccess: (r) => {
      toast.success(t("attributeSet", { count: r.updated.length }));
      if (r.skipped.length > 0) {
        const titles = new Map(drafts.map((d) => [d.id, d.title]));
        setSkipped(r.skipped.map((s) => ({ title: titles.get(s.draftId) ?? s.draftId, reason: s.reason })));
      } else onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && (skipped ? onDone() : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("setAttributeOf", { count: drafts.length })}</DialogTitle>
          <DialogDescription>{t("setAttributeBody", { category: first?.categoryPath ?? "—" })}</DialogDescription>
        </DialogHeader>
        {skipped ? (
          <div className="grid gap-2 text-sm">
            <p className="text-text-700">{t("attributeSkipped", { count: skipped.length })}</p>
            <ul className="list-disc pl-5 text-text-700">
              {skipped.map((s) => (
                <li key={s.title}>
                  {s.title}: {s.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : categoryId === null && detail.isSuccess ? (
          <p className="text-sm text-text-700">{t("attributeNoCategory")}</p>
        ) : rules.data?.rulesPending || detail.isPending || rules.isPending ? (
          <p className="text-sm text-text-700" aria-live="polite">
            {t("rulesLoading")}
          </p>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="bulk-attribute">{t("attribute")}</Label>
              <Select
                value={attributeId}
                onValueChange={(v) => {
                  setAttributeId(v);
                  setValue({ valueIds: [], text: "", unit: "" });
                }}
              >
                <SelectTrigger id="bulk-attribute" className="w-full">
                  <SelectValue placeholder={t("attributePick")} />
                </SelectTrigger>
                <SelectContent>
                  {attributes.map((a) => (
                    <SelectItem key={a.attributeId} value={a.attributeId}>
                      {a.required ? t("attributeRequired", { name: a.name }) : a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {attribute ? (
              <div className="grid gap-1.5">
                <Label htmlFor="bulk-attribute-value" id="bulk-attribute-value-label">
                  {t("attributeValue")}
                </Label>
                <AttributeInput id="bulk-attribute-value" attribute={attribute} value={value} onChange={setValue} />
                <p className="text-[13px] text-text-500">{t("attributeClearHint")}</p>
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {skipped ? (
            <Button onClick={onDone}>{tCommon("close")}</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>
                {tCommon("cancel")}
              </Button>
              <Button disabled={!attribute} loading={apply.isPending} onClick={() => apply.mutate()}>
                {t("apply")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
