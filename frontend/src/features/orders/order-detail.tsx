"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
  AlertOctagon,
  AlertTriangle,
  Check,
  CircleCheck,
  Copy,
  FileDown,
  type LucideIcon,
  MoreHorizontal,
  PackageCheck,
  Printer,
  RefreshCw,
  Tag,
  Truck,
  Wallet,
  Warehouse,
} from "lucide-react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ChannelIcon } from "@/components/common/channel";
import { ErrorState, SlaPill, StatusPill } from "@/components/common/page";
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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useStores } from "@/features/stores/use-store-modes";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { formatDateTime, formatNumber, formatRupiah } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import { ArrangeDialog } from "./arrange-dialog";
import { DeadlinePill } from "./deadline-pill";
import {
  ARRANGEABLE,
  addressLines,
  canCancel,
  MOVABLE,
  ORDER_STEPS,
  type OrderDetail,
  type OrderStatus,
  type PrimaryAction,
  primaryActionOf,
  STATUS_PILL,
  stepOf,
  TRACKED,
} from "./order-meta";
import { TagPicker, TagPills, TagsDialog } from "./tags";
import { useOrderActions } from "./use-order-actions";

type Shipments = components["schemas"]["ShipmentListDto_Output"];
type OrderEvent = OrderDetail["events"][number];

const KNOWN_EVENTS = new Set([
  "created",
  "status_changed",
  "problem_added",
  "problem_resolved",
  "warehouse_changed",
  "note_changed",
  "tags_changed",
  "cancel_requested",
  "cancel_failed",
]);

/**
 * L04 Detail Pesanan as a 420 px side panel next to the list (DOKUMEN-UI-UX 14.2); full width on phones.
 * The order id lives in the URL (`?id=`), so a link opens the same order.
 */
export function OrderDetailSheet({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const t = useTranslations("orders");
  return (
    <Sheet open={orderId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[420px]">
        {orderId ? (
          <OrderDetailBody key={orderId} id={orderId} />
        ) : (
          <SheetTitle className="sr-only">{t("detailTitle")}</SheetTitle>
        )}
      </SheetContent>
    </Sheet>
  );
}

function OrderDetailBody({ id }: { id: string }) {
  const t = useTranslations("orders");
  const order = useQuery({
    queryKey: ["orders", "detail", id],
    queryFn: () => unwrap(api.GET("/v1/orders/{id}", { params: { path: { id } } })),
  });
  if (order.isPending) {
    return (
      <div className="grid gap-3 p-4" aria-busy>
        <SheetTitle className="sr-only">{t("detailTitle")}</SheetTitle>
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-32" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (order.isError) {
    return (
      <>
        <SheetHeader className="border-b">
          <SheetTitle>{t("detailTitle")}</SheetTitle>
        </SheetHeader>
        <ErrorState error={order.error} onRetry={() => order.refetch()} />
      </>
    );
  }
  return <OrderDetailContent order={order.data} />;
}

function OrderDetailContent({ order: o }: { order: OrderDetail }) {
  const t = useTranslations("orders");
  const can = useCan();
  const tz = useTimeZone();
  const queryClient = useQueryClient();
  const actions = useOrderActions();
  const [dialog, setDialog] = useState<"arrange" | "cancel" | "ship" | "warehouse" | "tags" | null>(null);
  const [waitingLabel, setWaitingLabel] = useState(false);
  const channel = o.store?.channel ?? null;
  const readOnly = useStores().readOnly(o.store?.id);
  // the api refuses seller steps on a read-only store's orders (store.read_only)
  const primary = readOnly ? null : primaryActionOf({ ...o, channel }, can);

  const shipments = useQuery({
    queryKey: ["orders", "shipments", o.id],
    queryFn: () => unwrap(api.GET("/v1/orders/{id}/shipments", { params: { path: { id: o.id } } })),
    enabled: channel !== "manual",
    // after "Siapkan label", look again until the worker attached the file
    refetchInterval: (q) => (waitingLabel && labelFiles(q.state.data).length === 0 ? 5_000 : false),
  });
  const labels = labelFiles(shipments.data);
  const warehouses = useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 5 * 60_000,
  });
  const warehouseName = o.warehouseId
    ? (warehouses.data?.items.find((w) => w.id === o.warehouseId)?.name ?? null)
    : null;
  // another active warehouse in scope, for an order nobody packed that the marketplace did not place (FR-ORD-12)
  const moveTargets = (warehouses.data?.items ?? []).filter((w) => w.active && w.id !== o.warehouseId);
  const canMove =
    !readOnly &&
    can("order:accept") &&
    o.fulfillmentMode === "seller" &&
    !o.warehouseFixed &&
    MOVABLE.has(o.status) &&
    moveTargets.length > 0;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["orders"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const fail = (error: unknown) => toast.error(errorMessage(error));

  const prepareLabel = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/shipments/labels", { body: { orderIds: [o.id] } })),
    onSuccess: () => {
      setWaitingLabel(true);
      toast.success(t("labelQueued"));
    },
    onError: fail,
  });
  const manual = useMutation({
    mutationFn: async (
      input:
        | { kind: "pay" }
        | { kind: "complete" }
        | { kind: "ship"; shippingProvider?: string; trackingNumber?: string },
    ) => {
      const path = { params: { path: { id: o.id } } };
      if (input.kind === "pay") return unwrap(api.POST("/v1/orders/{id}/pay", { ...path, body: {} }));
      if (input.kind === "complete") return unwrap(api.POST("/v1/orders/{id}/complete", path));
      const { kind: _, ...body } = input;
      return unwrap(api.POST("/v1/orders/{id}/ship", { ...path, body }));
    },
    onSuccess: (_, input) => {
      toast.success(t(`done_${input.kind}`));
      setDialog(null);
      refresh();
    },
    onError: fail,
  });

  const run = (action: PrimaryAction) => {
    if (action === "accept") actions.accept.mutate([o.id]);
    else if (action === "pack") actions.pack.mutate([o.id]);
    else if (action === "arrange") setDialog("arrange");
    else if (action === "label") prepareLabel.mutate();
    else if (action === "ship") setDialog("ship");
    else manual.mutate({ kind: action });
  };
  const busy = actions.busy || prepareLabel.isPending || manual.isPending;

  const menuArrange =
    !readOnly &&
    primary !== "arrange" &&
    channel !== "manual" &&
    o.fulfillmentMode === "seller" &&
    ARRANGEABLE.has(o.status) &&
    can("shipment:arrange");
  const menuCancel = !readOnly && canCancel(o) && can("order:cancel");
  const step = stepOf(o.status);
  const openProblems = o.problems.filter((p) => !p.resolvedAt);

  return (
    <>
      <SheetHeader className="gap-1.5 border-b pr-12">
        <div className="flex min-w-0 items-center gap-1">
          <SheetTitle className="truncate font-mono text-base">{o.externalOrderId}</SheetTitle>
          <CopyButton value={o.externalOrderId} label={t("copyNumber")} />
        </div>
        <SheetDescription asChild>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            <StatusPill tone={STATUS_PILL[o.status].tone} icon={STATUS_PILL[o.status].icon}>
              {o.statusLabel}
            </StatusPill>
            {o.store ? (
              <span className="flex items-center gap-1.5">
                <ChannelIcon channel={o.store.channel} />
                {o.store.name}
              </span>
            ) : null}
            <span>{formatDateTime(o.orderedAt, tz)}</span>
          </div>
        </SheetDescription>
      </SheetHeader>

      <div className="grid flex-1 content-start gap-3 overflow-y-auto bg-canvas p-4">
        {step !== null ? <Stepper current={step} /> : null}

        {o.status === "cancelled" ? (
          <Banner tone="neutral" icon={AlertOctagon}>
            {o.cancelReason ? t("cancelledBecause", { reason: o.cancelReason }) : t("cancelledPlain")}
          </Banner>
        ) : null}
        {o.cancelRequested && o.status !== "cancelled" ? (
          <Banner tone="warning" icon={AlertTriangle}>
            {t("buyerAskedCancel")}
          </Banner>
        ) : null}
        {readOnly ? (
          <Banner tone="warning" icon={AlertTriangle}>
            {t("storeReadOnly", { store: readOnly.name })}
          </Banner>
        ) : null}
        {o.fulfillmentMode === "marketplace" ? (
          <Banner tone="neutral" icon={Truck}>
            {t("marketplaceShips")}
          </Banner>
        ) : null}

        {openProblems.length > 0 ? (
          <ProblemsCard
            orderId={o.id}
            problems={openProblems}
            onResolved={refresh}
            onMove={canMove ? () => setDialog("warehouse") : null}
          />
        ) : null}

        <Section title={t("itemsTitle", { count: o.items.length })}>
          <ul className="grid gap-3">
            {o.items.map((item) => (
              <li key={item.id} className="flex gap-3">
                <ItemImage url={item.imageUrl} />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="line-clamp-2 text-sm font-medium text-text-900">{item.title}</span>
                  {item.variantName ? <span className="text-[13px] text-text-500">{item.variantName}</span> : null}
                  <span className="truncate font-mono text-[13px] text-text-700">{item.sku}</span>
                  {item.variantId === null ? (
                    <span className="text-[13px] text-danger">{t("problem_unmapped_sku")}</span>
                  ) : null}
                  {item.cancelledQty > 0 ? (
                    <span className="text-[13px] text-text-500">{t("cancelledQty", { count: item.cancelledQty })}</span>
                  ) : null}
                </div>
                <div className="grid content-start justify-items-end gap-0.5 text-sm">
                  <span className="tabular text-text-700">×{formatNumber(item.qty)}</span>
                  <span className="tabular font-medium text-text-900">{formatRupiah(item.lineTotal)}</span>
                </div>
              </li>
            ))}
          </ul>
        </Section>

        <ShippingCard
          order={o}
          shipments={shipments.data}
          labels={labels}
          warehouseName={warehouseName}
          onMove={canMove ? () => setDialog("warehouse") : null}
        />

        <Section title={t("paymentTitle")}>
          <dl className="grid gap-1.5 text-sm">
            <Row label={t("subtotal")} value={formatRupiah(o.subtotal)} />
            {o.discountTotal > 0 ? <Row label={t("discount")} value={`−${formatRupiah(o.discountTotal)}`} /> : null}
            {o.voucherSeller > 0 ? (
              <Row label={t("voucherSeller")} value={`−${formatRupiah(o.voucherSeller)}`} />
            ) : null}
            <Row label={t("shippingFee")} value={formatRupiah(o.shippingFeeBuyer)} />
            <div className="mt-1 flex items-center justify-between border-t pt-2">
              <dt className="font-semibold text-text-900">{t("total")}</dt>
              <dd className="tabular text-base font-bold text-text-900">{formatRupiah(o.total)}</dd>
            </div>
            {o.isCod ? <Row label={t("payment")} value={o.paidAt ? t("codPaid") : t("codUnpaid")} /> : null}
            {o.paymentMethod ? <Row label={t("payment")} value={t(`method_${o.paymentMethod}`)} /> : null}
          </dl>
        </Section>

        {o.buyerNote ? (
          <Section title={t("buyerNote")}>
            <p className="text-sm whitespace-pre-wrap text-text-700">{o.buyerNote}</p>
          </Section>
        ) : null}

        <TagsCard order={o} editable={can("order:tag")} onManage={() => setDialog("tags")} />

        <NoteCard order={o} editable={can("order:tag")} />

        <Section title={t("historyTitle")}>
          <ol className="grid gap-3">
            {[...o.events].reverse().map((e) => (
              <li key={e.id} className="grid gap-0.5 border-l-2 border-border pl-3">
                <span className="text-sm text-text-900">{eventText(e, t)}</span>
                <span className="text-[13px] text-text-500">
                  {formatDateTime(e.createdAt, tz)} ·{" "}
                  {t(`actor_${e.actorType === "user" || e.actorType === "marketplace" ? e.actorType : "system"}`)}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      </div>

      {primary || menuArrange || menuCancel || canMove ? (
        <div className="flex items-center gap-2 border-t bg-surface p-4">
          {primary === "label" && labels.length > 0 ? (
            <Button asChild className="flex-1">
              <a href={`/v1/files/${labels[0]}/download`} target="_blank" rel="noopener">
                <FileDown aria-hidden />
                {labels.length > 1 ? t("downloadLabels", { count: labels.length }) : t("downloadLabel")}
              </a>
            </Button>
          ) : primary ? (
            <Button className="flex-1" loading={busy} onClick={() => run(primary)}>
              <PrimaryIcon action={primary} />
              {primary === "label" && waitingLabel ? t("labelWaiting") : t(`action_${primary}`)}
            </Button>
          ) : (
            <span className="flex-1" />
          )}
          {menuArrange || menuCancel || canMove ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="icon" aria-label={t("moreActions")}>
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {menuArrange ? (
                  <DropdownMenuItem onSelect={() => setDialog("arrange")}>{t("action_arrange")}</DropdownMenuItem>
                ) : null}
                {canMove ? (
                  <DropdownMenuItem onSelect={() => setDialog("warehouse")}>
                    <Warehouse aria-hidden />
                    {t("moveWarehouse")}
                  </DropdownMenuItem>
                ) : null}
                {menuCancel ? (
                  <DropdownMenuItem variant="destructive" onSelect={() => setDialog("cancel")}>
                    {t("cancelOrder")}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}

      <ArrangeDialog
        orderIds={dialog === "arrange" ? [o.id] : null}
        busy={actions.arrange.isPending}
        onClose={() => setDialog(null)}
        onConfirm={(method) =>
          actions.arrange.mutate({ orderIds: [o.id], method }, { onSettled: () => setDialog(null) })
        }
      />
      <CancelDialog orderId={dialog === "cancel" ? o.id : null} onClose={() => setDialog(null)} onDone={refresh} />
      <MoveWarehouseDialog
        open={dialog === "warehouse"}
        orderId={o.id}
        current={warehouseName}
        targets={moveTargets}
        onClose={() => setDialog(null)}
        onDone={refresh}
      />
      <TagsDialog open={dialog === "tags"} onClose={() => setDialog(null)} />
      <ShipDialog
        open={dialog === "ship"}
        busy={manual.isPending}
        defaults={{ shippingProvider: o.shippingProvider ?? "", trackingNumber: o.trackingNumber ?? "" }}
        onClose={() => setDialog(null)}
        onConfirm={(input) => manual.mutate({ kind: "ship", ...input })}
      />
    </>
  );
}

/** Label files of an order's packages, in package order (a split Shopee order has one per package). */
function labelFiles(data: Shipments | undefined): string[] {
  return (data?.items ?? []).flatMap((s) => s.packages.flatMap((p) => (p.labelFileId ? [p.labelFileId] : [])));
}

const PRIMARY_ICON: Record<PrimaryAction, LucideIcon> = {
  pay: Wallet,
  accept: Check,
  pack: PackageCheck,
  arrange: Truck,
  label: Printer,
  ship: Truck,
  complete: CircleCheck,
};

function PrimaryIcon({ action }: { action: PrimaryAction }) {
  const Icon = PRIMARY_ICON[action];
  return <Icon aria-hidden />;
}

function Stepper({ current }: { current: number }) {
  const t = useTranslations("orders");
  return (
    <ol className="flex items-center gap-1 rounded-[10px] border bg-surface p-3" aria-label={t("progress")}>
      {ORDER_STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s} className="flex flex-1 items-center gap-1.5" aria-current={active ? "step" : undefined}>
            <span
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold",
                done && "bg-primary text-primary-foreground",
                active && "bg-primary-100 text-primary-600 ring-2 ring-primary",
                !done && !active && "bg-surface-2 text-text-500",
              )}
            >
              {done ? <Check className="size-3.5" aria-hidden /> : i + 1}
            </span>
            <span className={cn("truncate text-[13px]", active ? "font-semibold text-text-900" : "text-text-500")}>
              {t(`step_${s}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Section({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("grid gap-3 rounded-[10px] border bg-surface p-4", className)}>
      <h3 className="text-[15px] font-semibold text-text-900">{title}</h3>
      {children}
    </section>
  );
}

function Banner({
  tone,
  icon: Icon,
  children,
}: {
  tone: "neutral" | "warning";
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-[10px] border p-3 text-sm",
        tone === "warning" ? "border-warning/30 bg-warning-soft text-text-900" : "bg-surface-2 text-text-700",
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone === "warning" && "text-warning")} aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-text-500">{label}</dt>
      <dd className="tabular text-right text-text-900">{value}</dd>
    </div>
  );
}

function ItemImage({ url }: { url: string | null }) {
  if (!url) return <span className="size-14 shrink-0 rounded-lg bg-surface-2" aria-hidden />;
  // marketplace image hosts vary per shop; the browser loads them directly
  return (
    <Image
      src={url}
      alt=""
      width={56}
      height={56}
      unoptimized
      className="size-14 shrink-0 rounded-lg border object-cover"
    />
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const tCommon = useTranslations("common");
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? tCommon("copied") : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error(tCommon("copyFailed"));
        }
      }}
    >
      {copied ? <Check className="text-success" aria-hidden /> : <Copy aria-hidden />}
    </Button>
  );
}

function ProblemsCard({
  orderId,
  problems,
  onResolved,
  onMove,
}: {
  orderId: string;
  problems: OrderDetail["problems"];
  onResolved: () => void;
  onMove: (() => void) | null;
}) {
  const t = useTranslations("orders");
  const can = useCan();
  const resolve = useMutation({
    mutationFn: (problemId: string) =>
      unwrap(
        api.POST("/v1/orders/{id}/problems/{problemId}/resolve", {
          params: { path: { id: orderId, problemId } },
          body: {},
        }),
      ),
    onSuccess: () => {
      toast.success(t("problemResolved"));
      onResolved();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Section title={t("problemsTitle")} className="border-danger/30 bg-danger-soft">
      <ul className="grid gap-3">
        {problems.map((p) => (
          <li key={p.id} className="grid gap-2">
            <p className="flex items-start gap-2 text-sm text-text-900">
              <AlertOctagon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
              <span>
                <span className="font-medium">{t(`problem_${p.code}`)}</span>
                <span className="block text-[13px] text-text-700">{t(`problemHint_${p.code}`)}</span>
              </span>
            </p>
            <span className="flex flex-wrap gap-2">
              {/* L04: stock short here, maybe not in another warehouse */}
              {p.code === "insufficient_stock" && onMove ? (
                <Button size="sm" variant="secondary" onClick={onMove}>
                  <Warehouse aria-hidden />
                  {t("moveWarehouse")}
                </Button>
              ) : null}
              {can("order:accept") ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={resolve.isPending && resolve.variables === p.id}
                  onClick={() => resolve.mutate(p.id)}
                >
                  {t("markResolved")}
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ShippingCard({
  order: o,
  shipments,
  labels,
  warehouseName,
  onMove,
}: {
  order: OrderDetail;
  shipments: Shipments | undefined;
  labels: string[];
  warehouseName: string | null;
  onMove: (() => void) | null;
}) {
  const t = useTranslations("orders");
  const can = useCan();
  const tz = useTimeZone();
  const queryClient = useQueryClient();
  const [tracking, setTracking] = useState(false);
  // after "Perbarui", the worker reads the parcel; look again for a short while
  const [watchUntil, setWatchUntil] = useState(0);
  const address = addressLines(o.shippingAddress);
  const shipment = shipments?.items[0];
  const track = useQuery({
    queryKey: ["orders", "tracking", o.id],
    queryFn: () => unwrap(api.GET("/v1/orders/{id}/tracking", { params: { path: { id: o.id } } })),
    enabled: tracking,
    refetchInterval: () => (Date.now() < watchUntil ? 5_000 : false),
  });
  const refreshTracking = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/orders/{id}/tracking/refresh", { params: { path: { id: o.id } } })),
    onSuccess: (r) => {
      if (!r.queued) {
        toast.info(t("trackingFresh"));
        return;
      }
      toast.success(t("trackingQueued"));
      setTracking(true);
      setWatchUntil(Date.now() + 30_000);
      void queryClient.invalidateQueries({ queryKey: ["orders", "shipments", o.id] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  // the api reads parcels again for marketplace orders the seller ships, once they left
  const refreshable = o.store?.channel !== "manual" && o.fulfillmentMode === "seller" && TRACKED.has(o.status);
  return (
    <Section title={t("shippingTitle")}>
      <dl className="grid gap-1.5 text-sm">
        <Row
          label={t("courier")}
          value={
            [o.shippingProvider, o.shippingService !== o.shippingProvider ? o.shippingService : null]
              .filter(Boolean)
              .join(" · ") || "—"
          }
        />
        <div className="flex items-center justify-between gap-3">
          <dt className="text-text-500">{t("trackingNumber")}</dt>
          <dd className="flex items-center gap-1 text-right">
            {o.trackingNumber ? (
              <>
                <span className="font-mono text-text-900">{o.trackingNumber}</span>
                <CopyButton value={o.trackingNumber} label={t("copyTracking")} />
              </>
            ) : (
              <span className="text-text-500">{t("noTrackingYet")}</span>
            )}
          </dd>
        </div>
        {o.internalShipByAt ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-text-500">{t("pickupDeadline")}</dt>
            <dd className="flex flex-wrap items-center justify-end gap-1.5 text-text-900">
              {formatDateTime(o.internalShipByAt, tz)}
              <DeadlinePill order={{ ...o, sla: null, shipByAt: null }} />
            </dd>
          </div>
        ) : null}
        {o.shipByAt ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-text-500">{t("shipBy")}</dt>
            <dd className="flex flex-wrap items-center justify-end gap-1.5 text-text-900">
              {formatDateTime(o.shipByAt, tz)}
              {o.sla ? <SlaPill sla={o.sla} /> : null}
            </dd>
          </div>
        ) : null}
        {shipment ? (
          <Row label={t("shipmentStatus")} value={shipment.trackingStageLabel ?? shipment.statusLabel} />
        ) : null}
        {o.fulfillmentMode === "seller" ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-text-500">{t("warehouse")}</dt>
            <dd className="flex items-center gap-1 text-right text-text-900">
              {warehouseName ?? "—"}
              {onMove ? (
                <Button size="sm" variant="link" className="h-auto" onClick={onMove}>
                  {t("moveShort")}
                </Button>
              ) : null}
            </dd>
          </div>
        ) : null}
        {shipment?.lastError ? <p className="text-[13px] text-danger">{shipment.lastError}</p> : null}
      </dl>

      {labels.length > 0 && can("shipment:print") ? (
        <div className="flex flex-wrap gap-2">
          {labels.map((fileId, i) => (
            <Button key={fileId} asChild size="sm" variant="secondary">
              <a href={`/v1/files/${fileId}/download`} target="_blank" rel="noopener">
                <FileDown aria-hidden />
                {labels.length > 1 ? t("labelPackage", { n: i + 1 }) : t("downloadLabel")}
              </a>
            </Button>
          ))}
        </div>
      ) : null}

      <div className="grid gap-0.5 border-t pt-3 text-sm">
        <span className="text-[13px] text-text-500">{t("address")}</span>
        {o.addressHidden ? (
          <span className="text-text-500">{t("addressHidden")}</span>
        ) : o.shippingAddress === null ? (
          <span className="text-text-500">{t("noAddress")}</span>
        ) : (
          <>
            <span className="font-medium text-text-900">
              {address.name ?? o.buyerName ?? "—"}
              {address.phone ? <span className="font-normal text-text-500"> · {address.phone}</span> : null}
            </span>
            {address.lines.map((line) => (
              <span key={line} className="text-text-700">
                {line}
              </span>
            ))}
          </>
        )}
      </div>

      {o.trackingNumber &&
      ["shipped", "delivered", "completed", "return_in_progress", "returned"].includes(o.status) ? (
        <div className="grid gap-2 border-t pt-3">
          <span className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setTracking((v) => !v)} aria-expanded={tracking}>
              <Truck aria-hidden />
              {tracking ? t("hideTracking") : t("showTracking")}
            </Button>
            {refreshable ? (
              <Button
                size="sm"
                variant="ghost"
                loading={refreshTracking.isPending}
                onClick={() => refreshTracking.mutate()}
              >
                <RefreshCw aria-hidden />
                {t("refreshTracking")}
              </Button>
            ) : null}
          </span>
          {tracking ? (
            track.isPending ? (
              <Skeleton className="h-16" />
            ) : track.isError ? (
              <p className="text-[13px] text-danger">{errorMessage(track.error)}</p>
            ) : track.data.events.length === 0 ? (
              <p className="text-[13px] text-text-500">{track.data.error ?? t("noTrackingEvents")}</p>
            ) : (
              <ol className="grid gap-2">
                {[...track.data.events]
                  .sort((a, b) => b.at.localeCompare(a.at))
                  .slice(0, 6)
                  .map((e) => (
                    <li
                      key={`${e.at}|${e.packageId ?? ""}|${e.description}`}
                      className="grid gap-0.5 border-l-2 border-border pl-3 text-sm"
                    >
                      <span className="text-text-900">{e.description}</span>
                      <span className="text-[13px] text-text-500">{formatDateTime(e.at, tz)}</span>
                    </li>
                  ))}
              </ol>
            )
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

/** Internal note, saved when the field loses focus (L04: "simpan otomatis"). */
function NoteCard({ order: o, editable }: { order: OrderDetail; editable: boolean }) {
  const t = useTranslations("orders");
  const queryClient = useQueryClient();
  const saved = o.internalNote ?? "";
  const [value, setValue] = useState(saved);
  const save = useMutation({
    mutationFn: (note: string | null) =>
      unwrap(api.PUT("/v1/orders/{id}/note", { params: { path: { id: o.id } }, body: { note } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["orders", "detail", o.id] }),
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Section title={t("internalNote")}>
      {editable ? (
        <>
          <Textarea
            value={value}
            maxLength={2000}
            rows={3}
            placeholder={t("internalNotePlaceholder")}
            aria-label={t("internalNote")}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => {
              if (value.trim() !== saved.trim()) save.mutate(value.trim() || null);
            }}
          />
          <span className="text-[13px] text-text-500" aria-live="polite">
            {save.isPending ? t("noteSaving") : save.isSuccess ? t("noteSaved") : t("noteHint")}
          </span>
        </>
      ) : (
        <p className="text-sm whitespace-pre-wrap text-text-700">{saved || "—"}</p>
      )}
    </Section>
  );
}

function CancelDialog({
  orderId,
  onClose,
  onDone,
}: {
  orderId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("orders");
  const tCommon = useTranslations("common");
  const [reason, setReason] = useState<string | null>(null);
  const reasons = useQuery({
    queryKey: ["orders", "cancel-reasons", orderId],
    queryFn: () => unwrap(api.GET("/v1/orders/{id}/cancel-reasons", { params: { path: { id: orderId ?? "" } } })),
    enabled: orderId !== null,
  });
  const cancel = useMutation({
    mutationFn: (code: string) =>
      unwrap(api.POST("/v1/orders/{id}/cancel", { params: { path: { id: orderId ?? "" } }, body: { reason: code } })),
    onSuccess: () => {
      toast.success(t("cancelSent"));
      onDone();
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Dialog open={orderId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("cancelTitle")}</DialogTitle>
          <DialogDescription>{t("cancelBody")}</DialogDescription>
        </DialogHeader>
        {reasons.isPending ? (
          <Skeleton className="h-24" />
        ) : reasons.isError ? (
          <ErrorState error={reasons.error} onRetry={() => reasons.refetch()} />
        ) : reasons.data.items.length === 0 ? (
          <p className="text-sm text-text-700">{t("cancelNoReasons")}</p>
        ) : (
          <RadioGroup value={reason ?? ""} onValueChange={setReason} className="gap-2">
            {reasons.data.items.map((r) => (
              <div key={r.code} className="flex items-center gap-3 rounded-lg border p-3">
                <RadioGroupItem value={r.code} id={`reason-${r.code}`} />
                <Label htmlFor={`reason-${r.code}`} className="font-normal text-text-900">
                  {r.label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={!reason}
            loading={cancel.isPending}
            onClick={() => reason && cancel.mutate(reason)}
          >
            {t("cancelConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Tandai dikirim" for a manual order: courier and tracking number are optional (backend 8.22). */
function ShipDialog({
  open,
  busy,
  defaults,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  defaults: { shippingProvider: string; trackingNumber: string };
  onClose: () => void;
  onConfirm: (input: { shippingProvider?: string; trackingNumber?: string }) => void;
}) {
  const t = useTranslations("orders");
  const tCommon = useTranslations("common");
  const [provider, setProvider] = useState(defaults.shippingProvider);
  const [number, setNumber] = useState(defaults.trackingNumber);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm({
              ...(provider.trim() ? { shippingProvider: provider.trim() } : {}),
              ...(number.trim() ? { trackingNumber: number.trim() } : {}),
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("shipTitle")}</DialogTitle>
            <DialogDescription>{t("shipBody")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="ship-provider">{t("courier")}</Label>
            <Input id="ship-provider" value={provider} maxLength={100} onChange={(e) => setProvider(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ship-number">{t("trackingNumber")}</Label>
            <Input
              id="ship-number"
              value={number}
              maxLength={100}
              className="font-mono"
              onChange={(e) => setNumber(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" loading={busy}>
              {t("action_ship")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** L04 "Beri tag": the order's tags, changed with the same picker as the list's bulk bar. */
function TagsCard({ order: o, editable, onManage }: { order: OrderDetail; editable: boolean; onManage: () => void }) {
  const t = useTranslations("orders");
  return (
    <Section title={t("tagsTitle")}>
      {o.tags.length > 0 ? <TagPills tags={o.tags} max={20} /> : <p className="text-sm text-text-500">{t("noTags")}</p>}
      {editable ? (
        <TagPicker
          orders={[o]}
          onManage={onManage}
          trigger={
            <Button size="sm" variant="secondary" className="justify-self-start">
              <Tag aria-hidden />
              {t("editTags")}
            </Button>
          }
        />
      ) : null}
    </Section>
  );
}

/**
 * "Pindah gudang" (FR-ORD-12): another warehouse for an order nobody packed yet. Its reservations follow;
 * recorded stock short there turns the order into a problem, as when it came in.
 */
function MoveWarehouseDialog({
  open,
  orderId,
  current,
  targets,
  onClose,
  onDone,
}: {
  open: boolean;
  orderId: string;
  current: string | null;
  targets: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("orders");
  const tCommon = useTranslations("common");
  const [target, setTarget] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: (warehouseId: string) =>
      unwrap(api.PUT("/v1/orders/{id}/warehouse", { params: { path: { id: orderId } }, body: { warehouseId } })),
    onSuccess: (_, warehouseId) => {
      toast.success(t("moved", { warehouse: targets.find((w) => w.id === warehouseId)?.name ?? "" }));
      setTarget(null);
      onDone();
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t("moveTitle")}</DialogTitle>
          <DialogDescription>{t("moveBody")}</DialogDescription>
        </DialogHeader>
        {current ? <p className="text-sm text-text-700">{t("moveFrom", { warehouse: current })}</p> : null}
        <RadioGroup value={target ?? ""} onValueChange={setTarget} className="gap-2" aria-label={t("moveTo")}>
          {targets.map((w) => (
            <div key={w.id} className="flex items-center gap-3 rounded-lg border p-3">
              <RadioGroupItem value={w.id} id={`move-${w.id}`} />
              <Label htmlFor={`move-${w.id}`} className="font-normal text-text-900">
                {w.name}
              </Label>
            </div>
          ))}
        </RadioGroup>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button disabled={!target} loading={move.isPending} onClick={() => target && move.mutate(target)}>
            {t("moveSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function eventText(e: OrderEvent, t: ReturnType<typeof useTranslations<"orders">>): string {
  const status = (s: OrderStatus | null) => (s ? t(`status_${s}`) : "—");
  const code = typeof e.payload.code === "string" ? e.payload.code : null;
  switch (e.type) {
    case "status_changed":
      return t("event_status_changed", { from: status(e.fromStatus), to: status(e.toStatus) });
    case "problem_added":
    case "problem_resolved":
      return t(`event_${e.type}`, { problem: code && isProblemCode(code) ? t(`problem_${code}`) : (code ?? "—") });
    default:
      return KNOWN_EVENTS.has(e.type)
        ? t(
            `event_${e.type as "created" | "warehouse_changed" | "note_changed" | "tags_changed" | "cancel_requested" | "cancel_failed"}`,
          )
        : e.toStatus
          ? t("event_status_changed", { from: status(e.fromStatus), to: status(e.toStatus) })
          : t("event_other");
  }
}

const PROBLEM_CODES = new Set<string>([
  "unmapped_sku",
  "insufficient_stock",
  "unmapped_warehouse",
  "address_incomplete",
  "duplicate",
  "watchlist",
  "high_value",
  "fulfillment_conflict",
]);

function isProblemCode(code: string): code is OrderDetail["problems"][number]["code"] {
  return PROBLEM_CODES.has(code);
}
