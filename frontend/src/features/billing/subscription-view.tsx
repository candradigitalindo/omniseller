"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { ExternalLink } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatDate, formatRupiah } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import {
  actionNeedsPayments,
  asksFirst,
  type BillingState,
  canVoid,
  INVOICE_TONE,
  type Invoice,
  type Plan,
  type PlanAction,
  paymentMethodOf,
  periodNote,
  planAction,
  STATUS_TONE,
  USAGE_METRICS,
  type UsageMetric,
  usagePct,
  usageTone,
} from "./billing-meta";

export const billingKey = ["billing", "subscription"] as const;

type T = ReturnType<typeof useTranslations<"billing">>;

/**
 * Langganan & Tagihan (UI L45; PRD 15.1; backend doc 8.32): the plan in force and where it stands, this
 * month's usage against the quotas, the plans to choose from, and the invoices. Paid plans are paid on
 * Xendit's page; the api hears from Xendit and switches the plan. Moving up starts when paid, less what is
 * left of a paid month; moving down waits for the end of the paid month. The Owner's (settings:billing).
 */
export function SubscriptionView() {
  const t = useTranslations("billing");
  const can = useCan();
  const allowed = can("settings:billing");
  const state = useQuery({
    queryKey: billingKey,
    queryFn: () => unwrap(api.GET("/v1/billing/subscription")),
    enabled: allowed,
    // an invoice waits: its payment page is on its way, or Xendit's confirmation may come any moment
    refetchInterval: (q) => (q.state.data?.pendingInvoice ? 5_000 : false),
  });
  useReturnFromPayment(allowed);
  if (!allowed) return <PageHeader title={t("title")} description={t("noAccess")} />;
  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      {state.isPending ? (
        <div className="grid gap-4" aria-busy>
          <Skeleton className="h-40" />
          <Skeleton className="h-64" />
        </div>
      ) : state.isError ? (
        <ErrorState error={state.error} onRetry={() => state.refetch()} />
      ) : (
        <Loaded state={state.data} />
      )}
    </>
  );
}

/** Back from Xendit's page (`?bayar=sukses` or `gagal`): say so once, then clean the address. */
function useReturnFromPayment(enabled: boolean) {
  const t = useTranslations("billing");
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const result = params.get("bayar");
  useEffect(() => {
    if (!enabled || !result) return;
    if (result === "sukses") toast.success(t("returnedPaid"));
    else toast.error(t("returnedFailed"));
    router.replace(pathname);
  }, [enabled, result, router, pathname, t]);
}

function Loaded({ state }: { state: BillingState }) {
  return (
    <div className="grid gap-4">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <CurrentPlanCard state={state} />
        <UsageCard state={state} />
      </div>
      {state.pendingInvoice ? <PendingInvoice state={state} invoice={state.pendingInvoice} /> : null}
      <PlansSection state={state} />
      <InvoicesCard state={state} />
    </div>
  );
}

function priceText(t: T, plan: Pick<Plan, "priceMonthly">): string {
  return plan.priceMonthly > 0 ? t("perMonth", { price: formatRupiah(plan.priceMonthly) }) : t("free");
}

function CurrentPlanCard({ state }: { state: BillingState }) {
  const t = useTranslations("billing");
  const tz = useTimeZone();
  const note = periodNote(state);
  const d = (at: string) => formatDate(at, tz);
  const noteText = (() => {
    switch (note.key) {
      case "trialEnds":
        return t("trialEnds", { date: d(note.date), days: note.days });
      case "trialPaid":
        return t("trialPaid", { date: d(note.date) });
      case "pastDue":
        return t("pastDue", { date: d(note.date) });
      case "prepaid":
        return t("prepaid", { plan: note.plan, date: d(note.date), until: d(note.until) });
      case "endsOn":
        return t("endsOn", { date: d(note.date), next: note.next });
      case "renewsOn":
        return t("renewsOn", { date: d(note.date) });
      default:
        return t("freePlan");
    }
  })();
  return (
    <Card data-testid="current-plan">
      <CardHeader>
        <CardDescription>{t("currentPlan")}</CardDescription>
        <CardTitle className="flex flex-wrap items-center gap-2 text-xl">
          {t("planName", { plan: state.plan.name })}
          <StatusPill tone={STATUS_TONE[state.status]}>{t(`status_${state.status}`)}</StatusPill>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        <p className="text-lg font-semibold tabular-nums">{priceText(t, state.plan)}</p>
        <p className="text-text-700">{noteText}</p>
      </CardContent>
    </Card>
  );
}

function UsageCard({ state }: { state: BillingState }) {
  const t = useTranslations("billing");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("usageTitle")}</CardTitle>
        <CardDescription>{t("usageBody")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {USAGE_METRICS.map((metric) => (
          <UsageBar key={metric} metric={metric} value={state.usage[metric].value} limit={state.usage[metric].limit} />
        ))}
      </CardContent>
    </Card>
  );
}

function UsageBar({ metric, value, limit }: { metric: UsageMetric; value: number; limit: number | null }) {
  const t = useTranslations("billing");
  const pct = usagePct(value, limit);
  const tone = usageTone(pct);
  const label = t(`usage_${metric}`);
  const text = limit === null ? t("usageUnlimited", { value }) : t("usageOf", { value, limit });
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-text-700 tabular-nums">{text}</span>
      </div>
      {pct !== null ? (
        <Progress
          value={Math.min(100, pct)}
          aria-label={`${label}: ${text}`}
          className={cn(
            "h-2",
            tone === "danger" && "*:data-[slot=progress-indicator]:bg-danger",
            tone === "warning" && "*:data-[slot=progress-indicator]:bg-warning",
          )}
        />
      ) : null}
      {metric === "orders" && pct !== null && pct >= 100 ? (
        <p className="text-xs text-danger">{t("usageOver")}</p>
      ) : null}
    </div>
  );
}

function PayLink({ invoice, size = "default" }: { invoice: Invoice; size?: "default" | "sm" }) {
  const t = useTranslations("billing");
  if (!invoice.invoiceUrl) {
    return (
      <span className="text-sm text-text-500" role="status">
        {t("pendingPreparing")}
      </span>
    );
  }
  return (
    <Button asChild size={size}>
      <a href={invoice.invoiceUrl} aria-label={t("payNowFor", { number: invoice.number })}>
        <ExternalLink aria-hidden />
        {t("payNow")}
      </a>
    </Button>
  );
}

/** The invoice to pay now, above the plans: a move up waits for it, a renewal keeps the plan going. */
function PendingInvoice({ state, invoice }: { state: BillingState; invoice: Invoice }) {
  const t = useTranslations("billing");
  const tz = useTimeZone();
  const queryClient = useQueryClient();
  const withdraw = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/billing/invoices/{id}/void", { params: { path: { id: invoice.id } } })),
    onSuccess: () => {
      toast.success(t("voided"));
      void queryClient.invalidateQueries({ queryKey: billingKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const amount = formatRupiah(invoice.amount);
  return (
    <Card size="sm" className="bg-warning-soft/40" role="status" aria-label={t("pendingTitle")}>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <p className="font-medium">{t("pendingTitle")}</p>
          <p className="text-sm text-text-700">
            {invoice.kind === "upgrade"
              ? t("pendingUpgrade", {
                  number: invoice.number,
                  plan: invoice.planName,
                  amount,
                  date: formatDate(invoice.dueAt, tz),
                })
              : t("pendingRenewal", {
                  number: invoice.number,
                  plan: invoice.planName,
                  amount,
                  start: formatDate(invoice.periodStart, tz),
                  end: formatDate(invoice.periodEnd, tz),
                  date: formatDate(invoice.dueAt, tz),
                })}
          </p>
          {invoice.creditAmount > 0 ? (
            <p className="text-sm text-text-700">
              {t("pendingCredit", { credit: formatRupiah(invoice.creditAmount) })}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PayLink invoice={invoice} />
          {canVoid(invoice, state) ? (
            <Button
              variant="ghost"
              aria-label={t("voidInvoiceFor", { number: invoice.number })}
              disabled={withdraw.isPending}
              onClick={() => withdraw.mutate()}
            >
              {t("voidInvoice")}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function PlansSection({ state }: { state: BillingState }) {
  const t = useTranslations("billing");
  const tz = useTimeZone();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<Plan | null>(null);
  const change = useMutation({
    mutationFn: (planCode: string) => unwrap(api.POST("/v1/billing/subscription", { body: { planCode } })),
    onSuccess: (data, planCode) => {
      queryClient.setQueryData(billingKey, data);
      setConfirm(null);
      const name = data.plans.find((p) => p.code === planCode)?.name ?? "";
      if (data.pendingInvoice?.planCode === planCode) {
        toast.success(data.pendingInvoice.kind === "upgrade" ? t("chosenUpgrade") : t("chosenRenewal"));
      } else if (data.plan.code === planCode && data.plan.priceMonthly === 0) {
        toast.success(t("downgradedNow"));
      } else if (data.nextPlan?.code === planCode && data.currentPeriodEnd) {
        toast.success(t("scheduledToast", { plan: name, date: formatDate(data.currentPeriodEnd, tz) }));
      } else {
        toast.success(t("stayed", { plan: data.plan.name }));
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <section aria-labelledby="plans-heading" className="grid gap-3">
      <div className="grid gap-1">
        <h2 id="plans-heading" className="text-base font-semibold">
          {t("plansTitle")}
        </h2>
        <p className="text-sm text-text-700">{t("plansBody")}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {state.plans.map((plan) => (
          <PlanCard
            key={plan.code}
            plan={plan}
            state={state}
            busy={change.isPending}
            onChoose={(action) => (asksFirst(action) ? setConfirm(plan) : change.mutate(plan.code))}
          />
        ))}
      </div>
      <ConfirmDialog
        plan={confirm}
        state={state}
        busy={change.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && change.mutate(confirm.code)}
      />
    </section>
  );
}

/** A plan's quotas as the card lists them. */
function limitLines(t: T, plan: Plan): string[] {
  const l = plan.limits;
  return [
    l.stores === null ? t("unlimited_stores") : t("limit_stores", { count: l.stores }),
    l.warehouses === null ? t("unlimited_warehouses") : t("limit_warehouses", { count: l.warehouses }),
    l.ordersPerMonth === null ? t("unlimited_orders") : t("limit_orders", { count: l.ordersPerMonth }),
    l.users === null ? t("unlimited_users") : t("limit_users", { count: l.users }),
  ];
}

function actionLabel(t: T, action: PlanAction, plan: Plan, tz: string): string {
  switch (action.kind) {
    case "current":
      return t("current");
    case "stay":
      return t("stay", { plan: plan.name });
    case "keep":
      return t("keep", { plan: plan.name });
    case "renew":
      return t("renew", { plan: plan.name });
    case "scheduled":
      return t("scheduled", { date: formatDate(action.at, tz) });
    case "pending":
      return t("preparingShort");
    case "upgrade":
      return t("upgradeTo", { plan: plan.name });
    case "switch":
      return t("switchTo", { plan: plan.name });
    case "at_end":
    case "free_now":
      return plan.priceMonthly === 0 ? t("downgradeTo", { plan: plan.name }) : t("switchTo", { plan: plan.name });
    case "locked":
      return t("choose", { plan: plan.name });
  }
}

function PlanCard({
  plan,
  state,
  busy,
  onChoose,
}: {
  plan: Plan;
  state: BillingState;
  busy: boolean;
  onChoose: (action: PlanAction) => void;
}) {
  const t = useTranslations("billing");
  const tz = useTimeZone();
  const action = planAction(state, plan);
  const needsPayments = actionNeedsPayments(action, plan);
  const current = plan.code === state.plan.code;
  const fixed = ["current", "scheduled", "pending", "locked"].includes(action.kind);
  const disabled = busy || fixed || (needsPayments && !state.paymentsAvailable);
  return (
    <Card className={cn(current && "ring-2 ring-primary")} aria-current={current ? "true" : undefined}>
      <CardHeader>
        <CardTitle>{plan.name}</CardTitle>
        <CardDescription className="tabular-nums">{priceText(t, plan)}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <ul className="grid gap-1 text-sm text-text-700">
          {limitLines(t, plan).map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>{t("features", { count: plan.features.length })}</li>
        </ul>
        {action.kind === "pending" && action.invoice.invoiceUrl ? (
          <PayLink invoice={action.invoice} />
        ) : (
          <Button
            variant={
              action.kind === "upgrade" || action.kind === "keep" || action.kind === "renew" ? "default" : "outline"
            }
            disabled={disabled}
            onClick={() => onChoose(action)}
          >
            {actionLabel(t, action, plan, tz)}
          </Button>
        )}
        {action.kind === "locked" ? (
          <p className="text-xs text-text-500">{t("lockedHint", { date: formatDate(action.from, tz) })}</p>
        ) : needsPayments && !state.paymentsAvailable ? (
          <p className="text-xs text-text-500">{t("paymentsOff")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A move down at the end of the paid month, or to the free plan at once: the new quotas are spelled out. */
function ConfirmDialog({
  plan,
  state,
  busy,
  onClose,
  onConfirm,
}: {
  plan: Plan | null;
  state: BillingState;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("billing");
  const tc = useTranslations("common");
  const tz = useTimeZone();
  const action = plan ? planAction(state, plan) : null;
  const free = plan?.priceMonthly === 0;
  const limits = plan ? limitLines(t, plan).join(", ") : "";
  const until = state.currentPeriodEnd ? formatDate(state.currentPeriodEnd, tz) : "";
  const body = !plan
    ? null
    : action?.kind === "at_end"
      ? free
        ? t("confirmAtEndFree", { from: state.plan.name, date: until, limits })
        : t("confirmAtEndPaid", {
            from: state.plan.name,
            date: until,
            plan: plan.name,
            price: formatRupiah(plan.priceMonthly),
            limits,
          })
      : state.status === "trialing"
        ? t("confirmTrialFree", { limits })
        : t("confirmFreeNow", { limits });
  return (
    <Dialog open={plan !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-120">
        <DialogHeader>
          <DialogTitle>
            {free
              ? action?.kind === "free_now"
                ? t("confirmFreeNowTitle", { plan: plan?.name ?? "" })
                : t("confirmDownTitle", { plan: plan?.name ?? "" })
              : t("confirmSwitchTitle", { plan: plan?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {tc("cancel")}
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {free ? t("confirmDown", { plan: plan?.name ?? "" }) : t("confirmSwitch", { plan: plan?.name ?? "" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One line under an invoice's status: when it was paid and how, when it is due, or why it failed. */
function invoiceNote(t: T, inv: Invoice, tz: string): string {
  if (inv.status === "paid" && inv.paidAt) {
    const method = paymentMethodOf(inv.paymentMethod);
    const via = [method ? t(`method_${method}`) : inv.paymentMethod, inv.paymentChannel].filter(Boolean).join(" ");
    return via
      ? t("paidOnVia", { date: formatDate(inv.paidAt, tz), via })
      : t("paidOn", { date: formatDate(inv.paidAt, tz) });
  }
  if (inv.status === "pending") return t("dueAt", { date: formatDate(inv.dueAt, tz) });
  return inv.status === "failed" ? (inv.error ?? "") : "";
}

function InvoicesCard({ state }: { state: BillingState }) {
  const t = useTranslations("billing");
  const tz = useTimeZone();
  const period = (inv: Invoice) => `${formatDate(inv.periodStart, tz)} – ${formatDate(inv.periodEnd, tz)}`;
  const kind = (inv: Invoice) => (inv.kind === "upgrade" ? t("kind_upgrade") : t("kind_renewal"));
  const credit = (inv: Invoice) =>
    inv.creditAmount > 0 ? t("creditLine", { credit: formatRupiah(inv.creditAmount) }) : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("invoicesTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {state.invoices.length === 0 ? (
          <p className="px-(--card-spacing) text-sm text-text-700">{t("invoicesEmpty")}</p>
        ) : (
          <>
            <div className="hidden px-(--card-spacing) md:block">
              <Table aria-label={t("invoicesTitle")}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colNumber")}</TableHead>
                    <TableHead>{t("colPlan")}</TableHead>
                    <TableHead>{t("colPeriod")}</TableHead>
                    <TableHead className="text-right">{t("colAmount")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.invoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-medium">{inv.number}</TableCell>
                      <TableCell>
                        <div className="grid">
                          <span>{inv.planName}</span>
                          <span className="text-xs text-text-500">{kind(inv)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{period(inv)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <div className="grid">
                          <span>{formatRupiah(inv.amount)}</span>
                          {credit(inv) ? <span className="text-xs text-text-500">{credit(inv)}</span> : null}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <div className="grid justify-items-start gap-1">
                          <StatusPill tone={INVOICE_TONE[inv.status]}>{t(`invoiceStatus_${inv.status}`)}</StatusPill>
                          {invoiceNote(t, inv, tz) ? (
                            <span className="text-xs text-text-500">{invoiceNote(t, inv, tz)}</span>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <ul className="divide-y md:hidden" aria-label={t("invoicesTitle")}>
              {state.invoices.map((inv) => (
                <li key={inv.id} className="grid gap-1.5 px-(--card-spacing) py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="grid min-w-0">
                      <span className="font-medium">{inv.number}</span>
                      <span className="text-[13px] text-text-500">
                        {inv.planName} · {kind(inv)}
                      </span>
                    </div>
                    <div className="grid justify-items-end text-right">
                      <span className="font-medium tabular-nums">{formatRupiah(inv.amount)}</span>
                      {credit(inv) ? <span className="text-xs text-text-500">{credit(inv)}</span> : null}
                    </div>
                  </div>
                  <span className="text-[13px] text-text-700">{period(inv)}</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone={INVOICE_TONE[inv.status]}>{t(`invoiceStatus_${inv.status}`)}</StatusPill>
                    {invoiceNote(t, inv, tz) ? (
                      <span className="text-xs text-text-500">{invoiceNote(t, inv, tz)}</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
