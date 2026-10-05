"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Minus, PackageSearch, Plus, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Field, fieldProps } from "@/components/common/field";
import { PageHeader } from "@/components/common/page";
import { Segmented } from "@/components/common/segmented";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useStores } from "@/features/stores/use-store-modes";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { formatNumber, formatRupiah } from "@/lib/format";
import { PROVINCES } from "@/lib/region";
import { useCan, useTimeZone } from "@/lib/session";
import {
  addLine,
  amount,
  availableFor,
  COURIERS,
  type Draft,
  type DraftLine,
  defaultPaid,
  draftProblems,
  emptyDraft,
  localInput,
  MAX_DAYS_BACK,
  manualOrderBody,
  PAYMENT_METHODS,
  type PickedVariant,
  type Problem,
  totals,
} from "./manual-order-meta";

const AUTO = "auto";
const NONE = "none";

/**
 * Pesanan manual baru (FR-ORD-09, backend 8.21; DOKUMEN-UI-UX L04a): a sale outside the marketplaces typed
 * by the seller (WhatsApp, Instagram, the shop counter). Items with their agreed price, the buyer, delivery
 * or pickup, and payment; stock is held at once, in the nearest warehouse that has everything unless one is
 * chosen. One Idempotency-Key per open form, so a double click or a retry never makes two orders.
 */
export function ManualOrderForm() {
  const t = useTranslations("manualOrder");
  const can = useCan();
  const tz = useTimeZone();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [key] = useState(() => crypto.randomUUID());
  const { byId } = useStores();
  const channels = [...byId.values()].filter((s) => s.channel === "manual" && s.status !== "disconnected");
  const warehouses = useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 5 * 60_000,
  });

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setLine = (variantId: string, patch: Partial<DraftLine>) =>
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.variantId === variantId ? { ...l, ...patch } : l)) }));
  const message = (p: Problem) => t(`problem_${p}`, { days: MAX_DAYS_BACK });

  const create = useMutation({
    mutationFn: (body: ReturnType<typeof manualOrderBody>) =>
      unwrap(api.POST("/v1/orders/manual", { params: { header: { "Idempotency-Key": key } }, body })),
    onSuccess: (order) => {
      toast.success(t("created", { number: order.externalOrderId }));
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["stores"] });
      router.push(`/pesanan?id=${order.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.errors.length > 0) {
        setErrors(Object.fromEntries(error.errors.map((e) => [e.path, e.message])));
      } else setErrors({ root: errorMessage(error) });
    },
  });

  if (!can("order:write")) return <PageHeader title={t("title")} description={t("noAccess")} />;

  const sum = totals(draft);
  const address = draft.shipTo === "address";
  const now = new Date();
  const latest = localInput(now, tz);
  const earliest = localInput(new Date(now.getTime() - MAX_DAYS_BACK * 86_400_000), tz);
  const error = (path: string) => errors[path];

  const submit = () => {
    const found = Object.entries(draftProblems(draft, latest, earliest));
    // the problems stay next to their fields; the line by the button says there are some
    setErrors(
      Object.fromEntries([
        ...found.map(([k, p]) => [k, message(p)]),
        ...(found.length > 0 ? [["root", t("fixFirst")]] : []),
      ]),
    );
    if (found.length === 0) create.mutate(manualOrderBody(draft, tz));
  };

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link href="/pesanan">
          <ArrowLeft aria-hidden />
          {t("back")}
        </Link>
      </Button>
      <PageHeader title={t("title")} description={t("description")} />
      <form
        noValidate
        className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("items")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <VariantSearch onPick={(v) => setDraft((d) => ({ ...d, lines: addLine(d.lines, v) }))} />
              {error("items") ? (
                <p role="alert" className="text-sm text-danger">
                  {error("items")}
                </p>
              ) : null}
              {draft.lines.length > 0 ? (
                <ul className="grid divide-y rounded-lg border">
                  {draft.lines.map((l, i) => (
                    <LineRow
                      key={l.variantId}
                      line={l}
                      index={i}
                      warehouseId={draft.warehouseId}
                      errors={{ qty: error(`items.${i}.qty`), unitPrice: error(`items.${i}.unitPrice`) }}
                      onChange={(patch) => setLine(l.variantId, patch)}
                      onRemove={() => set({ lines: draft.lines.filter((x) => x.variantId !== l.variantId) })}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-text-500">{t("noItemsYet")}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("buyer")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field id="buyer-name" label={t("buyerName")} error={error("buyer.name")}>
                <Input
                  value={draft.buyerName}
                  maxLength={255}
                  autoComplete="off"
                  onChange={(e) => set({ buyerName: e.target.value })}
                  {...fieldProps("buyer-name", error("buyer.name"))}
                />
              </Field>
              <Field id="buyer-phone" label={t("buyerPhone")} error={error("buyer.phone")}>
                <Input
                  value={draft.buyerPhone}
                  inputMode="tel"
                  autoComplete="off"
                  onChange={(e) => set({ buyerPhone: e.target.value })}
                  {...fieldProps("buyer-phone", error("buyer.phone"))}
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("delivery")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Segmented
                block
                label={t("delivery")}
                value={draft.shipTo}
                onChange={(shipTo) => set({ shipTo })}
                options={[
                  { value: "address", label: t("shipToAddress") },
                  { value: "pickup", label: t("shipToPickup") },
                ]}
              />
              {address ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="recipient-name" label={t("recipientName")} hint={t("recipientNameHint")}>
                    <Input
                      value={draft.recipientName}
                      placeholder={draft.buyerName}
                      autoComplete="off"
                      onChange={(e) => set({ recipientName: e.target.value })}
                      {...fieldProps("recipient-name", undefined, true)}
                    />
                  </Field>
                  <Field
                    id="recipient-phone"
                    label={t("recipientPhone")}
                    hint={t("recipientPhoneHint")}
                    error={error("shippingAddress.phone")}
                  >
                    <Input
                      value={draft.recipientPhone}
                      placeholder={draft.buyerPhone}
                      inputMode="tel"
                      autoComplete="off"
                      onChange={(e) => set({ recipientPhone: e.target.value })}
                      {...fieldProps("recipient-phone", error("shippingAddress.phone"), true)}
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field id="address-line1" label={t("line1")} error={error("shippingAddress.line1")}>
                      <Textarea
                        value={draft.line1}
                        rows={2}
                        autoComplete="off"
                        onChange={(e) => set({ line1: e.target.value })}
                        {...fieldProps("address-line1", error("shippingAddress.line1"))}
                      />
                    </Field>
                  </div>
                  <Field id="address-district" label={t("district")}>
                    <Input
                      value={draft.district}
                      autoComplete="off"
                      onChange={(e) => set({ district: e.target.value })}
                      {...fieldProps("address-district", undefined)}
                    />
                  </Field>
                  <Field id="address-city" label={t("city")}>
                    <Input
                      value={draft.city}
                      autoComplete="off"
                      onChange={(e) => set({ city: e.target.value })}
                      {...fieldProps("address-city", undefined)}
                    />
                  </Field>
                  <Field id="address-province" label={t("province")} hint={t("provinceHint")}>
                    <Select
                      value={draft.province || NONE}
                      onValueChange={(v) => set({ province: v === NONE ? "" : v })}
                    >
                      <SelectTrigger
                        id="address-province"
                        className="w-full"
                        aria-describedby="address-province-message"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{t("provinceNone")}</SelectItem>
                        {PROVINCES.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field id="address-postal" label={t("postalCode")}>
                    <Input
                      value={draft.postalCode}
                      inputMode="numeric"
                      maxLength={10}
                      autoComplete="off"
                      onChange={(e) => set({ postalCode: e.target.value })}
                      {...fieldProps("address-postal", undefined)}
                    />
                  </Field>
                  <Field id="courier" label={t("courier")}>
                    <Input
                      value={draft.shippingProvider}
                      list="courier-names"
                      autoComplete="off"
                      onChange={(e) => set({ shippingProvider: e.target.value })}
                      {...fieldProps("courier", undefined)}
                    />
                  </Field>
                  <datalist id="courier-names">
                    {COURIERS.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                  <Field id="courier-service" label={t("service")}>
                    <Input
                      value={draft.shippingService}
                      placeholder={t("servicePlaceholder")}
                      autoComplete="off"
                      onChange={(e) => set({ shippingService: e.target.value })}
                      {...fieldProps("courier-service", undefined)}
                    />
                  </Field>
                </div>
              ) : (
                <p className="text-sm text-text-500">{t("pickupHint")}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("more")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field
                id="order-channel"
                label={t("channel")}
                hint={channels.length === 0 ? t("channelFirst") : t("channelHint")}
              >
                <Select
                  value={draft.storeId || AUTO}
                  onValueChange={(v) => set({ storeId: v === AUTO ? "" : v })}
                  disabled={channels.length === 0}
                >
                  <SelectTrigger id="order-channel" className="w-full" aria-describedby="order-channel-message">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO}>
                      {channels.length === 0 ? t("channelNew") : t("channelDefault")}
                    </SelectItem>
                    {channels.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id="order-warehouse" label={t("warehouse")} hint={t("warehouseHint")}>
                <Select
                  value={draft.warehouseId || AUTO}
                  onValueChange={(v) => set({ warehouseId: v === AUTO ? "" : v })}
                >
                  <SelectTrigger id="order-warehouse" className="w-full" aria-describedby="order-warehouse-message">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO}>{t("warehouseAuto")}</SelectItem>
                    {(warehouses.data?.items ?? []).map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id="ordered-at" label={t("orderedAt")} hint={t("orderedAtHint")} error={error("orderedAt")}>
                <Input
                  type="datetime-local"
                  value={draft.orderedAt}
                  min={earliest}
                  max={latest}
                  onChange={(e) => set({ orderedAt: e.target.value })}
                  {...fieldProps("ordered-at", error("orderedAt"), true)}
                />
              </Field>
              <div className="hidden sm:block" />
              <Field id="buyer-note" label={t("buyerNote")} hint={t("buyerNoteHint")}>
                <Textarea
                  value={draft.buyerNote}
                  rows={2}
                  onChange={(e) => set({ buyerNote: e.target.value })}
                  {...fieldProps("buyer-note", undefined, true)}
                />
              </Field>
              <Field id="internal-note" label={t("internalNote")} hint={t("internalNoteHint")}>
                <Textarea
                  value={draft.internalNote}
                  rows={2}
                  onChange={(e) => set({ internalNote: e.target.value })}
                  {...fieldProps("internal-note", undefined, true)}
                />
              </Field>
            </CardContent>
          </Card>
        </div>

        <Card className="lg:sticky lg:top-20">
          <CardHeader>
            <CardTitle>{t("summary")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
              <dt className="text-text-700">{t("subtotal", { count: draft.lines.length })}</dt>
              <dd className="tabular text-right text-text-900">{formatRupiah(sum.subtotal)}</dd>
            </dl>
            <div className="grid grid-cols-2 gap-3">
              <Field id="discount" label={t("discount")} error={error("discount")}>
                <Input
                  value={draft.discount}
                  inputMode="numeric"
                  placeholder="0"
                  onChange={(e) => set({ discount: e.target.value })}
                  {...fieldProps("discount", error("discount"))}
                />
              </Field>
              {address ? (
                <Field id="shipping-fee" label={t("shippingFee")} error={error("shippingFee")}>
                  <Input
                    value={draft.shippingFee}
                    inputMode="numeric"
                    placeholder="0"
                    onChange={(e) => set({ shippingFee: e.target.value })}
                    {...fieldProps("shipping-fee", error("shippingFee"))}
                  />
                </Field>
              ) : null}
            </div>
            <div className="flex items-baseline justify-between gap-4 border-t pt-3">
              <span className="font-semibold text-text-900">{t("total")}</span>
              <span className="tabular text-xl font-bold text-text-900">{formatRupiah(sum.total)}</span>
            </div>

            <div className="grid gap-2">
              <span id="payment-label" className="text-sm font-medium text-text-700">
                {t("payment")}
              </span>
              <RadioGroup
                aria-labelledby="payment-label"
                value={draft.paymentMethod}
                onValueChange={(v) => {
                  const method = PAYMENT_METHODS.find((m) => m === v) ?? "transfer";
                  set({ paymentMethod: method, paid: defaultPaid(method) });
                }}
                className="grid grid-cols-2 gap-2"
              >
                {PAYMENT_METHODS.map((m) => (
                  <Label
                    key={m}
                    htmlFor={`pay-${m}`}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary-50"
                  >
                    <RadioGroupItem id={`pay-${m}`} value={m} />
                    {t(`pay_${m}`)}
                  </Label>
                ))}
              </RadioGroup>
            </div>
            {draft.paymentMethod === "cod" ? (
              <p className="text-sm text-text-500">{t("codHint")}</p>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="order-paid" className="font-normal">
                  {t("paid")}
                </Label>
                <Switch id="order-paid" checked={draft.paid} onCheckedChange={(paid) => set({ paid })} />
              </div>
            )}
            <p className="text-[13px] text-text-500">
              {draft.paid || draft.paymentMethod === "cod" ? t("statusNew") : t("statusUnpaid")}
            </p>

            {errors.root ? (
              <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
                {errors.root}
              </p>
            ) : null}
            <Button type="submit" size="lg" loading={create.isPending}>
              {t("submit")}
            </Button>
          </CardContent>
        </Card>
      </form>
    </>
  );
}

function LineRow({
  line,
  index,
  warehouseId,
  errors,
  onChange,
  onRemove,
}: {
  line: DraftLine;
  index: number;
  warehouseId: string;
  errors: { qty: string | undefined; unitPrice: string | undefined };
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("manualOrder");
  const available = availableFor(line, warehouseId);
  const qty = amount(line.qty);
  const title =
    line.variantName && line.variantName !== line.productName
      ? `${line.productName} · ${line.variantName}`
      : line.productName;
  const qtyId = `line-${index}-qty`;
  const priceId = `line-${index}-price`;
  return (
    <li className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-start">
      <div className="grid min-w-0 gap-0.5">
        <span className="truncate text-sm font-medium text-text-900" title={title}>
          {title}
        </span>
        <span className="font-mono text-[13px] text-text-500">{line.sku}</span>
        {available !== null ? (
          <span className={qty > available ? "text-[13px] font-medium text-warning" : "text-[13px] text-text-500"}>
            {qty > available ? t("stockShort", { count: available }) : t("stockAvailable", { count: available })}
          </span>
        ) : null}
      </div>
      <div className="grid gap-1">
        <Label htmlFor={qtyId} className="text-[13px] text-text-500">
          {t("qty")}
        </Label>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label={t("less", { sku: line.sku })}
            disabled={qty <= 1}
            onClick={() => onChange({ qty: String(Math.max(1, qty - 1)) })}
          >
            <Minus aria-hidden />
          </Button>
          <Input
            value={line.qty}
            inputMode="numeric"
            className="h-8 w-16 text-center"
            onChange={(e) => onChange({ qty: e.target.value })}
            {...fieldProps(qtyId, errors.qty)}
          />
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label={t("more1", { sku: line.sku })}
            onClick={() => onChange({ qty: String(qty + 1) })}
          >
            <Plus aria-hidden />
          </Button>
        </div>
        {errors.qty ? (
          <p id={`${qtyId}-message`} role="alert" className="text-[13px] text-danger">
            {errors.qty}
          </p>
        ) : null}
      </div>
      <div className="grid gap-1">
        <Label htmlFor={priceId} className="text-[13px] text-text-500">
          {t("unitPrice")}
        </Label>
        <Input
          value={line.unitPrice}
          inputMode="numeric"
          className="h-8 w-32 text-right"
          onChange={(e) => onChange({ unitPrice: e.target.value })}
          {...fieldProps(priceId, errors.unitPrice)}
        />
        {errors.unitPrice ? (
          <p id={`${priceId}-message`} role="alert" className="text-[13px] text-danger">
            {errors.unitPrice}
          </p>
        ) : amount(line.unitPrice) !== line.basePrice ? (
          <p className="text-[13px] text-text-500">{t("basePrice", { price: formatRupiah(line.basePrice) })}</p>
        ) : null}
      </div>
      <div className="flex items-start justify-between gap-2 sm:grid sm:justify-items-end">
        <span className="tabular pt-6 text-sm font-semibold text-text-900 sm:pt-6">
          {formatRupiah(qty * amount(line.unitPrice))}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("remove", { sku: line.sku })}
          onClick={onRemove}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
    </li>
  );
}

/** Waits for the typing to pause before searching. */
function useSettled(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/**
 * Finds variants by SKU, name, or barcode: prices from the catalog, ready-to-sell stock per warehouse from
 * the stock list. Enter on a scanned barcode or a full SKU adds that variant at once.
 */
function VariantSearch({ onPick }: { onPick: (v: PickedVariant) => void }) {
  const t = useTranslations("manualOrder");
  const can = useCan();
  const [q, setQ] = useState("");
  const [notFound, setNotFound] = useState<string | null>(null);
  const term = useSettled(q.trim());
  const seesStock = can("inventory:read");
  const products = useQuery({
    queryKey: ["products", "pick", term],
    queryFn: () => unwrap(api.GET("/v1/products", { params: { query: { q: term, status: "active", limit: 8 } } })),
    enabled: term.length >= 2,
  });
  const stock = useQuery({
    queryKey: ["stock", "pick-all", term],
    queryFn: () => unwrap(api.GET("/v1/inventory", { params: { query: { q: term, limit: 50 } } })),
    enabled: term.length >= 2 && seesStock,
  });
  const stockOf = (variantId: string): Record<string, number> | null => {
    if (!seesStock) return null;
    const row = stock.data?.items.find((r) => r.id === variantId);
    return row ? Object.fromEntries(row.warehouses.map((w) => [w.warehouseId, w.available])) : {};
  };
  const options: PickedVariant[] = (products.data?.items ?? []).flatMap((p) =>
    p.variants
      .filter((v) => v.status === "active")
      .map((v) => ({
        variantId: v.id,
        sku: v.sku,
        productName: p.name,
        variantName: v.name || null,
        basePrice: v.basePrice,
        stock: stockOf(v.id),
      })),
  );

  const scan = useMutation({
    mutationFn: async (code: string) => {
      const match = await unwrap(api.GET("/v1/products/lookup", { params: { query: { code } } }));
      const product = await unwrap(api.GET("/v1/products/{id}", { params: { path: { id: match.product.id } } }));
      const variant = product.variants.find((v) => v.id === match.variant.id);
      const rows = seesStock
        ? await unwrap(api.GET("/v1/inventory", { params: { query: { q: match.variant.sku, limit: 5 } } }))
        : null;
      const row = rows?.items.find((r) => r.id === match.variant.id);
      return {
        variantId: match.variant.id,
        sku: match.variant.sku,
        productName: product.name,
        variantName: variant?.name || null,
        basePrice: variant?.basePrice ?? 0,
        stock: seesStock
          ? row
            ? Object.fromEntries(row.warehouses.map((w) => [w.warehouseId, w.available]))
            : {}
          : null,
      } satisfies PickedVariant;
    },
    onSuccess: (v) => {
      onPick(v);
      setQ("");
      setNotFound(null);
    },
    onError: (_e, code) => setNotFound(code),
  });

  return (
    <div className="grid gap-2">
      <Label htmlFor="item-search">{t("addItem")}</Label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-500"
          aria-hidden
        />
        <Input
          id="item-search"
          value={q}
          autoComplete="off"
          placeholder={t("searchPlaceholder")}
          className="pl-9"
          onChange={(e) => {
            setQ(e.target.value);
            setNotFound(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const code = q.trim();
              if (code) scan.mutate(code);
            }
          }}
          aria-describedby="item-search-hint"
        />
      </div>
      <p id="item-search-hint" className="text-[13px] text-text-500">
        {notFound ? <span className="text-danger">{t("codeNotFound", { code: notFound })}</span> : t("searchHint")}
      </p>
      {/* only results for what is in the box now: a list left from the last word must not take a click */}
      {term.length >= 2 && term === q.trim() && products.data ? (
        options.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-text-500">
            <PackageSearch className="size-4" aria-hidden />
            {t("noMatch")}
          </p>
        ) : (
          <ul className="grid max-h-64 gap-1 overflow-y-auto" aria-label={t("results")}>
            {options.map((o) => {
              const total = o.stock ? Math.max(0, ...Object.values(o.stock)) : null;
              const title =
                o.variantName && o.variantName !== o.productName
                  ? `${o.productName} · ${o.variantName}`
                  : o.productName;
              return (
                <li key={o.variantId}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      onPick(o);
                      setQ("");
                    }}
                  >
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate text-sm text-text-900">{title}</span>
                      <span className="font-mono text-[13px] text-text-500">{o.sku}</span>
                    </span>
                    <span className="grid shrink-0 justify-items-end gap-0.5 text-[13px]">
                      <span className="tabular text-text-900">{formatRupiah(o.basePrice)}</span>
                      {total !== null ? (
                        <span className={total > 0 ? "text-text-500" : "text-danger"}>
                          {t("stockShortList", { count: formatNumber(total) })}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}
