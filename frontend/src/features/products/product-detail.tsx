"use client";

import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Barcode, MoreHorizontal, Plus, Printer, Unlink } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ChannelIcon } from "@/components/common/channel";
import { Field, fieldProps } from "@/components/common/field";
import { EmptyState, ErrorState, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap, unwrapWithEtag } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { formatDateTime, formatNumber, formatRupiah } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import { BarcodeLabelsDialog } from "./barcode-labels";
import {
  type HistoryEntry,
  historyValue,
  type Listing,
  type Product,
  parseAttributeNames,
  parseImageUrls,
  type Variant,
  variantLabel,
} from "./product-meta";
import { Thumb } from "./products-view";

const TABS = ["info", "variants", "listings", "history"] as const;
type Tab = (typeof TABS)[number];
const WHOLE = /^\d+$/;

/** L14 Detail dan Edit Produk (DOKUMEN-UI-UX 14.3): one product, its variants, its listings, its history. */
export function ProductDetailView({ id }: { id: string }) {
  const t = useTranslations("products");
  const { params, set } = useUrlParams();
  const tab: Tab = TABS.find((x) => x === params.get("tab")) ?? "info";
  const product = useQuery({
    queryKey: ["products", "detail", id],
    queryFn: () => unwrapWithEtag(api.GET("/v1/products/{id}", { params: { path: { id } } })),
  });

  if (product.isPending) {
    return (
      <div className="grid gap-3" aria-busy>
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (product.isError) return <ErrorState error={product.error} onRetry={() => product.refetch()} />;
  const p = product.data.data;

  return (
    <>
      <Link href="/produk" className="mb-2 inline-flex items-center gap-1.5 text-sm text-text-500 hover:text-text-900">
        <ArrowLeft className="size-4" aria-hidden />
        {t("title")}
      </Link>
      <Header product={p} />
      <Tabs value={tab} onValueChange={(v) => set({ tab: v === "info" ? null : v })}>
        <TabsList variant="line" className="mb-4 w-full justify-start overflow-x-auto border-b" aria-label={t("tabs")}>
          {TABS.map((x) => (
            <TabsTrigger key={x} value={x} className="flex-none px-3">
              {t(`tab_${x}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="info">
          <InfoTab key={product.data.etag ?? p.updatedAt} product={p} etag={product.data.etag} />
        </TabsContent>
        <TabsContent value="variants">
          <VariantsTab product={p} />
        </TabsContent>
        <TabsContent value="listings">
          <ListingsTab product={p} />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab productId={p.id} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function Header({ product: p }: { product: Product }) {
  const t = useTranslations("products");
  const tCommon = useTranslations("common");
  const can = useCan();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["products"] });
  const archive = useMutation({
    mutationFn: (status: "active" | "archived") =>
      unwrap(api.PATCH("/v1/products/{id}", { params: { path: { id: p.id } }, body: { status } })),
    onSuccess: (saved) => {
      toast.success(t(saved.status === "archived" ? "archivedDone" : "activatedDone"));
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/products/{id}", { params: { path: { id: p.id } } })),
    onSuccess: () => {
      toast.success(t("deleted", { name: p.name }));
      refresh();
      router.push("/produk");
    },
    onError: (error) => {
      setConfirmDelete(false);
      toast.error(errorMessage(error));
    },
  });
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <Thumb url={p.imageUrls[0] ?? null} size={56} />
        <div className="grid min-w-0 gap-1">
          <h1 className="text-[22px] leading-tight font-bold text-text-900 md:text-2xl">{p.name}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-text-500">
            <span className="font-mono">{p.sku}</span>
            <StatusPill tone={p.status === "active" ? "success" : "neutral"}>{t(`status_${p.status}`)}</StatusPill>
          </div>
        </div>
      </div>
      {can("catalog:write") ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="icon" aria-label={t("moreActions")}>
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => archive.mutate(p.status === "active" ? "archived" : "active")}>
              {t(p.status === "active" ? "archive" : "activate")}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
              {t("delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("deleteTitle", { name: p.name })}</DialogTitle>
            <DialogDescription>{t("deleteBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              {tCommon("cancel")}
            </Button>
            <Button variant="destructive" loading={remove.isPending} onClick={() => remove.mutate()}>
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type InfoValues = {
  name: string;
  sku: string;
  description: string;
  brand: string;
  categoryPath: string;
  attributeNames: string;
  imageUrls: string;
};

function valuesOf(p: Product): InfoValues {
  return {
    name: p.name,
    sku: p.sku,
    description: p.description ?? "",
    brand: p.brand ?? "",
    categoryPath: p.categoryPath ?? "",
    attributeNames: p.attributeNames.join(", "),
    imageUrls: p.imageUrls.join("\n"),
  };
}

/** "Informasi": saved together with "Simpan perubahan", only when something changed (L14). */
function InfoTab({ product: p, etag }: { product: Product; etag: string | null }) {
  const t = useTranslations("products");
  const can = useCan();
  const queryClient = useQueryClient();
  const initial = valuesOf(p);
  const [v, setV] = useState<InfoValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const editable = can("catalog:write");
  const dirty = (Object.keys(initial) as (keyof InfoValues)[]).some((k) => initial[k] !== v[k]);
  const images = parseImageUrls(v.imageUrls);

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/v1/products/{id}", {
          params: { path: { id: p.id } },
          ...(etag ? { headers: { "If-Match": etag } } : {}),
          body: {
            name: v.name.trim(),
            sku: v.sku.trim(),
            description: v.description.trim() || null,
            brand: v.brand.trim() || null,
            categoryPath: v.categoryPath.trim() || null,
            attributeNames: parseAttributeNames(v.attributeNames),
            imageUrls: images.urls,
          },
        }),
      ),
    onSuccess: () => {
      toast.success(t("saved"));
      void queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.errors.length > 0) {
        setErrors(Object.fromEntries(error.errors.map((e) => [e.path.split(".")[0] ?? e.path, e.message])));
      } else {
        toast.error(errorMessage(error));
      }
    },
  });
  const submit = () => {
    const found: Record<string, string> = {};
    if (!v.name.trim()) found.name = t("required");
    if (!v.sku.trim()) found.sku = t("required");
    if (images.invalid.length > 0) found.imageUrls = t("imageHttps", { url: images.invalid[0]! });
    else if (images.urls.length > 9) found.imageUrls = t("imageMax");
    if (parseAttributeNames(v.attributeNames).length > 3) found.attributeNames = t("attributeMax");
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate();
  };
  const field = (key: keyof InfoValues) => ({
    value: v[key],
    disabled: !editable,
    onChange: (e: { target: { value: string } }) => setV((prev) => ({ ...prev, [key]: e.target.value })),
  });

  return (
    <div className="grid gap-4">
      <section className="grid gap-4 rounded-[10px] border bg-surface p-4 md:grid-cols-2 md:p-5">
        <Field id="p-name" label={t("name")} error={errors.name}>
          <Input maxLength={255} {...field("name")} {...fieldProps("p-name", errors.name)} />
        </Field>
        <Field id="p-sku" label={t("parentSku")} error={errors.sku}>
          <Input maxLength={64} className="font-mono" {...field("sku")} {...fieldProps("p-sku", errors.sku)} />
        </Field>
        <Field id="p-category" label={t("category")} hint={t("categoryHint")} error={errors.categoryPath}>
          <Input maxLength={255} {...field("categoryPath")} {...fieldProps("p-category", errors.categoryPath, true)} />
        </Field>
        <Field id="p-brand" label={t("brand")} error={errors.brand}>
          <Input maxLength={100} {...field("brand")} {...fieldProps("p-brand", errors.brand)} />
        </Field>
        <div className="md:col-span-2">
          <Field id="p-description" label={t("description")} error={errors.description}>
            <Textarea
              rows={6}
              maxLength={20000}
              {...field("description")}
              {...fieldProps("p-description", errors.description)}
            />
          </Field>
        </div>
        <Field id="p-attributes" label={t("attributes")} hint={t("attributesHint")} error={errors.attributeNames}>
          <Input {...field("attributeNames")} {...fieldProps("p-attributes", errors.attributeNames, true)} />
        </Field>
        <Field id="p-images" label={t("images")} hint={t("imagesHint")} error={errors.imageUrls}>
          <Textarea
            rows={3}
            className="font-mono text-[13px]"
            {...field("imageUrls")}
            {...fieldProps("p-images", errors.imageUrls, true)}
          />
        </Field>
        {images.urls.length > 0 ? (
          <ul className="flex flex-wrap gap-2 md:col-span-2" aria-label={t("images")}>
            {images.urls.map((url) => (
              <li key={url}>
                <Thumb url={url} size={80} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {editable ? (
        // sticks to the bottom of the screen while the form scrolls; above the phone's bottom navigation
        <div className="sticky bottom-16 z-20 -mx-4 border-t bg-surface/95 px-4 py-3 backdrop-blur md:bottom-4 md:mx-0 md:rounded-[10px] md:border md:shadow-float">
          <div className="flex items-center justify-end gap-3">
            {dirty ? <span className="text-sm text-text-500">{t("unsaved")}</span> : null}
            <Button
              variant="secondary"
              disabled={!dirty || save.isPending}
              onClick={() => {
                setV(initial);
                setErrors({});
              }}
            >
              {t("discard")}
            </Button>
            <Button disabled={!dirty} loading={save.isPending} onClick={submit}>
              {t("saveChanges")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type VariantDraft = {
  sku: string;
  name: string;
  barcode: string;
  basePrice: string;
  costPrice: string;
  weightG: string;
  status: "active" | "archived";
};

function draftOf(v: Variant): VariantDraft {
  return {
    sku: v.sku,
    name: v.name,
    barcode: v.barcode ?? "",
    basePrice: String(v.basePrice),
    costPrice: v.costPrice === null ? "" : String(v.costPrice),
    weightG: String(v.weightG),
    status: v.status,
  };
}

/** "Varian": every cell edits in place; a row saves on its own once something in it changed (L14). */
function VariantsTab({ product: p }: { product: Product }) {
  const t = useTranslations("products");
  const can = useCan();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [labels, setLabels] = useState(false);
  const seesCost = can("finance:read");
  const editable = can("catalog:write");
  const prints = can("shipment:print");
  const active = p.variants.filter((v) => v.status === "active");
  const withoutBarcode = p.variants.filter((v) => !v.barcode && v.status === "active");
  const barcodes = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/v1/products/barcodes", { body: { variantIds: withoutBarcode.map((v) => v.id) } })),
    onSuccess: (r) => {
      toast.success(t("barcodesMade", { count: r.items.filter((x) => x.generated).length }));
      void queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <section className="grid gap-3">
      {editable || (prints && active.length > 0) ? (
        <div className="flex flex-wrap gap-2">
          {editable ? (
            <Button variant="secondary" onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              {t("addVariant")}
            </Button>
          ) : null}
          {editable && withoutBarcode.length > 0 ? (
            <Button variant="secondary" loading={barcodes.isPending} onClick={() => barcodes.mutate()}>
              <Barcode aria-hidden />
              {t("makeBarcodes", { count: withoutBarcode.length })}
            </Button>
          ) : null}
          {prints && active.length > 0 ? (
            <Button variant="secondary" onClick={() => setLabels(true)}>
              <Printer aria-hidden />
              {t("printBarcodeLabels")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <BarcodeLabelsDialog
        open={labels}
        variants={active.map((v) => ({ id: v.id, sku: v.sku, name: v.name, barcode: v.barcode }))}
        onClose={() => setLabels(false)}
      />
      <div className="overflow-x-auto rounded-[10px] border bg-surface">
        <Table>
          <TableHeader className="bg-surface-2">
            <TableRow>
              <TableHead className="min-w-60">{t("variantSku")}</TableHead>
              <TableHead className="min-w-36">{t("variantName")}</TableHead>
              <TableHead className="min-w-36">{t("barcode")}</TableHead>
              <TableHead className="min-w-28 text-right">{t("price")}</TableHead>
              {seesCost ? <TableHead className="min-w-28 text-right">{t("cost")}</TableHead> : null}
              <TableHead className="min-w-24 text-right">{t("weightG")}</TableHead>
              <TableHead className="text-right">{t("colListings")}</TableHead>
              <TableHead className="min-w-40" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.variants.map((v) => (
              <VariantRow
                key={`${v.id}-${p.updatedAt}`}
                productId={p.id}
                variant={v}
                seesCost={seesCost}
                editable={editable}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      <AddVariantDialog productId={p.id} open={adding} onClose={() => setAdding(false)} seesCost={seesCost} />
    </section>
  );
}

function VariantRow({
  productId,
  variant: v,
  seesCost,
  editable,
}: {
  productId: string;
  variant: Variant;
  seesCost: boolean;
  editable: boolean;
}) {
  const t = useTranslations("products");
  const queryClient = useQueryClient();
  const initial = draftOf(v);
  const [d, setD] = useState<VariantDraft>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const dirty = (Object.keys(initial) as (keyof VariantDraft)[]).some((k) => initial[k] !== d[k]);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/v1/products/{id}/variants/{variantId}", {
          params: { path: { id: productId, variantId: v.id } },
          body: {
            sku: d.sku.trim(),
            name: d.name.trim() || variantLabel(v),
            barcode: d.barcode.trim() || null,
            basePrice: Number(d.basePrice),
            ...(seesCost && d.costPrice.trim() ? { costPrice: Number(d.costPrice) } : {}),
            weightG: Number(d.weightG),
            status: d.status,
          },
        }),
      ),
    onSuccess: () => {
      toast.success(t("variantSaved", { sku: d.sku.trim() }));
      setProblem(null);
      void queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error) =>
      setProblem(error instanceof ApiError ? (error.errors[0]?.message ?? errorMessage(error)) : errorMessage(error)),
  });
  const submit = () => {
    if (!d.sku.trim()) return setProblem(t("required"));
    if (!WHOLE.test(d.basePrice.trim())) return setProblem(t("wholeRupiah"));
    if (d.costPrice.trim() && !WHOLE.test(d.costPrice.trim())) return setProblem(t("wholeRupiah"));
    if (!WHOLE.test(d.weightG.trim()) || Number(d.weightG) < 1) return setProblem(t("weightRequired"));
    setProblem(null);
    save.mutate();
  };
  const cell = (key: keyof Omit<VariantDraft, "status">, label: string, extra = "") => (
    <Input
      aria-label={`${label} ${v.sku}`}
      value={d[key]}
      disabled={!editable}
      className={`h-9 rounded-none border-0 border-b border-transparent bg-transparent px-1 shadow-none focus-visible:border-primary focus-visible:ring-0 md:h-9 ${extra}`}
      onChange={(e) => setD((prev) => ({ ...prev, [key]: e.target.value }))}
    />
  );
  return (
    <>
      <TableRow className={d.status === "archived" ? "opacity-70" : undefined}>
        <TableCell>{cell("sku", t("variantSku"), "font-mono text-sm")}</TableCell>
        <TableCell>{cell("name", t("variantName"))}</TableCell>
        <TableCell>{cell("barcode", t("barcode"), "font-mono text-sm")}</TableCell>
        <TableCell>{cell("basePrice", t("price"), "tabular text-right")}</TableCell>
        {seesCost ? <TableCell>{cell("costPrice", t("cost"), "tabular text-right")}</TableCell> : null}
        <TableCell>{cell("weightG", t("weightG"), "tabular text-right")}</TableCell>
        <TableCell className="tabular text-right">{formatNumber(v.listingCount)}</TableCell>
        <TableCell>
          <div className="flex items-center justify-end gap-1">
            {editable ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setD((prev) => ({ ...prev, status: prev.status === "active" ? "archived" : "active" }))}
              >
                {t(d.status === "active" ? "archive" : "activate")}
              </Button>
            ) : null}
            {dirty ? (
              <Button size="sm" loading={save.isPending} onClick={submit}>
                {t("saveRow")}
              </Button>
            ) : null}
          </div>
        </TableCell>
      </TableRow>
      {problem ? (
        <TableRow>
          <TableCell colSpan={seesCost ? 8 : 7} className="text-[13px] text-danger" role="alert">
            {problem}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function AddVariantDialog({
  productId,
  open,
  onClose,
  seesCost,
}: {
  productId: string;
  open: boolean;
  onClose: () => void;
  seesCost: boolean;
}) {
  const t = useTranslations("products");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const empty = { sku: "", name: "", basePrice: "", costPrice: "", weightG: "" };
  const [d, setD] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/products/{id}/variants", {
          params: { path: { id: productId } },
          body: {
            sku: d.sku.trim(),
            ...(d.name.trim() ? { name: d.name.trim() } : {}),
            basePrice: Number(d.basePrice),
            ...(seesCost && d.costPrice.trim() ? { costPrice: Number(d.costPrice) } : {}),
            weightG: Number(d.weightG),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(t("variantAdded", { sku: d.sku.trim() }));
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      setD(empty);
      onClose();
    },
    onError: (error) =>
      setErrors(
        error instanceof ApiError && error.errors.length > 0
          ? Object.fromEntries(error.errors.map((e) => [e.path, e.message]))
          : { root: errorMessage(error) },
      ),
  });
  const submit = () => {
    const found: Record<string, string> = {};
    if (!d.sku.trim()) found.sku = t("required");
    if (!WHOLE.test(d.basePrice.trim())) found.basePrice = t("wholeRupiah");
    if (d.costPrice.trim() && !WHOLE.test(d.costPrice.trim())) found.costPrice = t("wholeRupiah");
    if (!WHOLE.test(d.weightG.trim()) || Number(d.weightG) < 1) found.weightG = t("weightRequired");
    setErrors(found);
    if (Object.keys(found).length === 0) add.mutate();
  };
  const input = (key: keyof typeof empty) => ({
    value: d[key],
    onChange: (e: { target: { value: string } }) => setD((prev) => ({ ...prev, [key]: e.target.value })),
  });
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("addVariant")}</DialogTitle>
          <DialogDescription>{t("addVariantBody")}</DialogDescription>
        </DialogHeader>
        {errors.root ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {errors.root}
          </p>
        ) : null}
        <div className="grid gap-3">
          <Field id="nv-sku" label={t("variantSku")} error={errors.sku}>
            <Input className="font-mono" maxLength={64} {...input("sku")} {...fieldProps("nv-sku", errors.sku)} />
          </Field>
          <Field id="nv-name" label={t("variantName")} error={errors.name}>
            <Input maxLength={255} {...input("name")} {...fieldProps("nv-name", errors.name)} />
          </Field>
          <div className={seesCost ? "grid grid-cols-3 gap-2" : "grid grid-cols-2 gap-2"}>
            <Field id="nv-price" label={t("price")} error={errors.basePrice}>
              <Input
                inputMode="numeric"
                className="tabular"
                {...input("basePrice")}
                {...fieldProps("nv-price", errors.basePrice)}
              />
            </Field>
            {seesCost ? (
              <Field id="nv-cost" label={t("cost")} error={errors.costPrice}>
                <Input
                  inputMode="numeric"
                  className="tabular"
                  {...input("costPrice")}
                  {...fieldProps("nv-cost", errors.costPrice)}
                />
              </Field>
            ) : null}
            <Field id="nv-weight" label={t("weightG")} error={errors.weightG}>
              <Input
                inputMode="numeric"
                className="tabular"
                {...input("weightG")}
                {...fieldProps("nv-weight", errors.weightG)}
              />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button loading={add.isPending} onClick={submit}>
            {t("addVariant")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Listing tertaut": the marketplace listings mapped to each variant, per store (L14). */
function ListingsTab({ product: p }: { product: Product }) {
  const t = useTranslations("products");
  const can = useCan();
  const queryClient = useQueryClient();
  const results = useQueries({
    queries: p.variants.map((v) => ({
      queryKey: ["listings", "byVariant", v.id],
      queryFn: () => unwrap(api.GET("/v1/listings", { params: { query: { variantId: v.id, limit: 100 } } })),
    })),
  });
  const unmap = useMutation({
    mutationFn: (listingId: string) =>
      unwrap(api.PUT("/v1/listings/{id}/mapping", { params: { path: { id: listingId } }, body: { variantId: null } })),
    onSuccess: () => {
      toast.success(t("unmapped"));
      void queryClient.invalidateQueries({ queryKey: ["listings"] });
      void queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  if (results.some((r) => r.isPending)) return <Skeleton className="h-40" />;
  const failed = results.find((r) => r.isError);
  if (failed) return <ErrorState error={failed.error} onRetry={() => failed.refetch()} />;
  const listings: Listing[] = results.flatMap((r) => r.data?.items ?? []);
  if (listings.length === 0) {
    return (
      <div className="rounded-[10px] border bg-surface">
        <EmptyState title={t("noListings")} body={t("noListingsBody")} />
      </div>
    );
  }
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {listings.map((l) => (
        <li key={l.id} className="flex gap-3 rounded-[10px] border bg-surface p-4">
          <Thumb url={l.imageUrl} size={56} />
          <div className="grid min-w-0 flex-1 gap-1 text-sm">
            <span className="flex items-center gap-1.5 text-[13px] text-text-500">
              {l.store ? <ChannelIcon channel={l.store.channel} decorative /> : null}
              {l.store?.name ?? "—"}
            </span>
            <span className="line-clamp-2 font-medium text-text-900">{l.title}</span>
            {l.variantName ? <span className="text-[13px] text-text-500">{l.variantName}</span> : null}
            <span className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-mono text-text-700">{l.sku ?? "—"}</span>
              {l.price !== null ? <span className="tabular text-text-900">{formatRupiah(l.price)}</span> : null}
              <StatusPill tone={l.status === "active" ? "success" : l.status === "banned" ? "danger" : "neutral"}>
                {t(`listing_${l.status}`)}
              </StatusPill>
            </span>
            {l.mapping ? <span className="text-[13px] text-text-500">{t(`source_${l.mapping.source}`)}</span> : null}
          </div>
          {can("catalog:map") ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("unmapListing", { title: l.title })}
              loading={unmap.isPending && unmap.variables === l.id}
              onClick={() => unmap.mutate(l.id)}
            >
              <Unlink aria-hidden />
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** "Riwayat perubahan" (FR-PRD-11): who changed what, before and after, cost hidden without finance:read. */
function HistoryTab({ productId }: { productId: string }) {
  const t = useTranslations("products");
  const tCommon = useTranslations("common");
  const tz = useTimeZone();
  const history = useInfiniteQuery({
    queryKey: ["products", "history", productId],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/products/{id}/history", {
          params: { path: { id: productId }, query: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  if (history.isPending) return <Skeleton className="h-40" />;
  if (history.isError) return <ErrorState error={history.error} onRetry={() => history.refetch()} />;
  const entries = history.data.pages.flatMap((p) => p.items);
  if (entries.length === 0) {
    return (
      <div className="rounded-[10px] border bg-surface">
        <EmptyState title={t("noHistory")} />
      </div>
    );
  }
  return (
    <section className="grid gap-3 rounded-[10px] border bg-surface p-4">
      <ol className="grid gap-4">
        {entries.map((e) => (
          <HistoryItem key={e.id} entry={e} at={formatDateTime(e.at, tz)} />
        ))}
      </ol>
      {history.hasNextPage ? (
        <Button
          variant="secondary"
          className="justify-self-center"
          loading={history.isFetchingNextPage}
          onClick={() => history.fetchNextPage()}
        >
          {tCommon("loadMore")}
        </Button>
      ) : null}
    </section>
  );
}

function HistoryItem({ entry: e, at }: { entry: HistoryEntry; at: string }) {
  const t = useTranslations("products");
  const who: ReactNode = e.actor.name ?? t(`actor_${e.actor.type}`);
  return (
    <li className="grid gap-1 border-l-2 border-border pl-3">
      <span className="text-sm text-text-900">
        {t(`history_${e.action}`, {
          target: e.target.type === "variant" ? t("historyVariant", { sku: e.target.sku ?? "—" }) : t("historyProduct"),
        })}
      </span>
      <span className="text-[13px] text-text-500">
        {at} · {who}
      </span>
      {e.changes.length > 0 ? (
        <ul className="grid gap-0.5 text-[13px] text-text-700">
          {e.changes.map((c) => (
            <li key={c.field}>
              <span className="text-text-500">{c.label}:</span>{" "}
              {c.hidden
                ? t("hiddenValue")
                : `${historyValue(c.field, c.before, formatRupiah)} → ${historyValue(c.field, c.after, formatRupiah)}`}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
