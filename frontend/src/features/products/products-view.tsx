"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { ChevronDown, ChevronRight, Download, FileUp, Package, Plus, Search } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Fragment, useEffect, useState } from "react";
import { FilterChip } from "@/components/common/filter-chip";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { formatNumber, formatRupiah } from "@/lib/format";
import { useCan } from "@/lib/session";
import { ProductCreateDialog, ProductImportDialog } from "./product-dialogs";
import { costRange, listingTotal, type ProductListItem, priceRange, variantLabel } from "./product-meta";

const PAGE = 50;

export function rupiahRange(r: { min: number; max: number } | null): string {
  if (!r) return "—";
  return r.min === r.max ? formatRupiah(r.min) : `${formatRupiah(r.min)} – ${formatRupiah(r.max)}`;
}

/**
 * L13 Daftar Produk (DOKUMEN-UI-UX 14.3): master products with their variants, prices, cost (finance:read
 * only), and how many marketplace listings follow them. Stock lives on the Stok screen.
 */
export function ProductsView() {
  const t = useTranslations("products");
  const tCommon = useTranslations("common");
  const can = useCan();
  const { params, set } = useUrlParams();
  const q = params.get("q") ?? "";
  const archived = params.get("status") === "archived";
  const [search, setSearch] = useState(q);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<"create" | "import" | null>(null);

  useEffect(() => {
    if (search.trim() === q) return;
    const id = setTimeout(() => set({ q: search.trim() || null }), 300);
    return () => clearTimeout(id);
  }, [search, q, set]);

  const query = { ...(q ? { q } : {}), status: archived ? ("archived" as const) : ("active" as const) };
  const list = useInfiniteQuery({
    queryKey: ["products", "list", query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/products", {
          params: { query: { ...query, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const seesCost = rows.some((p) => p.variants.some((v) => v.costPrice !== null));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <PageHeader
        title={t("title")}
        actions={
          <>
            <Button asChild variant="secondary">
              <a href="/v1/products/export">
                <Download aria-hidden />
                {t("export")}
              </a>
            </Button>
            {can("catalog:write") ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button>
                    <Plus aria-hidden />
                    {t("add")}
                    <ChevronDown aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setDialog("create")}>
                    <Plus aria-hidden />
                    {t("addManual")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog("import")}>
                    <FileUp aria-hidden />
                    {t("addImport")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 md:max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-500"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={tCommon("search")}
            className="pl-9"
          />
        </div>
        <FilterChip active={archived} onClick={() => set({ status: archived ? null : "archived" })}>
          {t("archivedOnly")}
        </FilterChip>
      </div>

      <Card className="gap-0 py-0">
        {list.isPending ? (
          <div className="grid gap-2 p-4" aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Package}
            title={q || archived ? t("emptyFiltered") : t("empty")}
            body={q || archived ? undefined : t("emptyBody")}
            action={
              !q && !archived && can("catalog:write") ? (
                <Button onClick={() => setDialog("create")}>{t("addManual")}</Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table className="hidden md:table">
              <TableHeader className="bg-surface-2">
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>{t("colProduct")}</TableHead>
                  <TableHead>{t("colSku")}</TableHead>
                  <TableHead className="text-right">{t("colPrice")}</TableHead>
                  {seesCost ? <TableHead className="text-right">{t("colCost")}</TableHead> : null}
                  <TableHead className="text-right">{t("colListings")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => {
                  const expanded = open.has(p.id);
                  return (
                    <Fragment key={p.id}>
                      <TableRow className="h-[52px]">
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-expanded={expanded}
                            aria-label={t(expanded ? "hideVariants" : "showVariants", { name: p.name })}
                            onClick={() => toggle(p.id)}
                          >
                            {expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                          </Button>
                        </TableCell>
                        <TableCell>
                          <ProductName product={p} />
                        </TableCell>
                        <TableCell className="font-mono text-sm">{p.sku}</TableCell>
                        <TableCell className="tabular text-right">{rupiahRange(priceRange(p.variants))}</TableCell>
                        {seesCost ? (
                          <TableCell className="tabular text-right">{rupiahRange(costRange(p.variants))}</TableCell>
                        ) : null}
                        <TableCell className="tabular text-right">{formatNumber(listingTotal(p.variants))}</TableCell>
                        <TableCell>
                          <StatusPill tone={p.status === "active" ? "success" : "neutral"}>
                            {t(`status_${p.status}`)}
                          </StatusPill>
                        </TableCell>
                      </TableRow>
                      {expanded
                        ? p.variants.map((v) => (
                            <TableRow key={v.id} className="bg-surface-2/50">
                              <TableCell />
                              <TableCell className="pl-8 text-sm text-text-700">{variantLabel(v)}</TableCell>
                              <TableCell className="font-mono text-[13px] text-text-700">{v.sku}</TableCell>
                              <TableCell className="tabular text-right text-sm">{formatRupiah(v.basePrice)}</TableCell>
                              {seesCost ? (
                                <TableCell className="tabular text-right text-sm">
                                  {v.costPrice === null ? "—" : formatRupiah(v.costPrice)}
                                </TableCell>
                              ) : null}
                              <TableCell className="tabular text-right text-sm">
                                {formatNumber(v.listingCount)}
                              </TableCell>
                              <TableCell>
                                {v.status === "archived" ? (
                                  <StatusPill tone="neutral">{t("status_archived")}</StatusPill>
                                ) : null}
                              </TableCell>
                            </TableRow>
                          ))
                        : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>

            <ul className="divide-y md:hidden">
              {rows.map((p) => (
                <li key={p.id}>
                  <Link href={`/produk/${p.id}`} className="flex gap-3 p-4">
                    <Thumb url={p.imageUrls[0] ?? null} size={56} />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="line-clamp-2 text-sm font-medium text-text-900">{p.name}</span>
                      <span className="truncate font-mono text-[13px] text-text-700">{p.sku}</span>
                      <span className="flex items-center justify-between gap-2 text-[13px] text-text-500">
                        <span>{t("variantCount", { count: p.variants.length })}</span>
                        <span className="tabular font-medium text-text-900">{rupiahRange(priceRange(p.variants))}</span>
                      </span>
                    </span>
                  </Link>
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

      <ProductCreateDialog open={dialog === "create"} onClose={() => setDialog(null)} />
      <ProductImportDialog open={dialog === "import"} onClose={() => setDialog(null)} />
    </>
  );
}

function ProductName({ product: p }: { product: ProductListItem }) {
  const t = useTranslations("products");
  return (
    <Link href={`/produk/${p.id}`} className="group flex min-w-0 items-center gap-3">
      <Thumb url={p.imageUrls[0] ?? null} size={40} />
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate font-medium text-text-900 group-hover:text-primary group-hover:underline">
          {p.name}
        </span>
        <span className="text-[13px] text-text-500">{t("variantCount", { count: p.variants.length })}</span>
      </span>
    </Link>
  );
}

export function Thumb({ url, size }: { url: string | null; size: 40 | 56 | 80 }) {
  const box = size === 40 ? "size-10" : size === 56 ? "size-14" : "size-20";
  if (!url) return <span className={cn(box, "shrink-0 rounded-lg bg-surface-2")} aria-hidden />;
  // product images are on marketplace or seller hosts; the browser loads them directly
  return (
    <Image
      src={url}
      alt=""
      width={size}
      height={size}
      unoptimized
      className={cn(box, "shrink-0 rounded-lg border object-cover")}
    />
  );
}
