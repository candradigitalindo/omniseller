"use client";

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Plug, ShoppingBag } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ChannelIcon } from "@/components/common/channel";
import { EmptyState, ErrorState, PageHeader, StatusPill, type Tone } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { criticalStockHref } from "@/features/stock/stock-meta";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { firstName, formatNumber, formatPercentChange, formatRupiah, greeting } from "@/lib/format";
import { useCan, useSession } from "@/lib/session";

const SalesChart = dynamic(() => import("./sales-chart").then((m) => m.SalesChart), {
  ssr: false,
  loading: () => <Skeleton className="h-72 w-full" />,
});

type Dashboard = components["schemas"]["DashboardDto_Output"];
type Range = Dashboard["range"];
type Task = Dashboard["tasks"][number];

/** Where each "Perlu tindakan" task leads; tasks of screens still to come have no button yet. */
const TASK_HREF: Partial<Record<Task["kind"], string>> = {
  orders_due: "/pesanan?due=soon",
  orders_problem: "/pesanan?status=problem",
  orders_new: "/pesanan?status=new",
  listings_unmapped: "/listing",
  stores_reconnect: "/integrasi",
};

const SEVERITY_TONE: Record<Task["severity"], Tone> = { critical: "danger", warning: "warning", info: "info" };
const HEALTH_TONE: Record<Dashboard["stores"][number]["health"], Tone> = {
  healthy: "success",
  attention: "warning",
  problem: "danger",
};

function KpiTile({
  label,
  value,
  change,
  note,
  href,
  tone,
}: {
  label: string;
  value: string;
  change?: { pct: number | null; versus: string } | undefined;
  note?: string | undefined;
  href?: string | undefined;
  tone?: Tone | undefined;
}) {
  const body = (
    <Card className="h-full gap-1 transition-colors hover:border-border-strong">
      <CardContent className="grid gap-1">
        <span className="text-[13px] text-text-500">{label}</span>
        <span
          className={cn(
            "tabular text-[26px] leading-tight font-bold text-text-900 md:text-[28px]",
            tone === "warning" && "text-warning",
            tone === "danger" && "text-danger",
          )}
        >
          {value}
        </span>
        {change && change.pct !== null ? (
          <span
            className={cn(
              "flex items-center gap-1 text-[13px] font-medium",
              change.pct > 0 ? "text-success" : change.pct < 0 ? "text-danger" : "text-text-500",
            )}
          >
            {change.pct > 0 ? <ArrowUpRight className="size-4" aria-hidden /> : null}
            {change.pct < 0 ? <ArrowDownRight className="size-4" aria-hidden /> : null}
            {formatPercentChange(change.pct)} <span className="font-normal text-text-500">{change.versus}</span>
          </span>
        ) : note ? (
          <span className="text-[13px] text-text-500">{note}</span>
        ) : null}
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-4" aria-busy>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-24" />
      <Skeleton className="h-80" />
    </div>
  );
}

/**
 * L01 Ringkasan: in ten seconds, how today looks and what to do (DOKUMEN-UI-UX 14.1). Sections the user
 * may not see come as `null` from the api and are left out (backend doc 8.16).
 */
export function DashboardView() {
  const t = useTranslations("dashboard");
  const me = useSession();
  const can = useCan();
  const [range, setRange] = useState<Range>("today");
  const tz = me.tenant.timezone;

  const dashboard = useQuery({
    queryKey: ["dashboard", range],
    queryFn: () => unwrap(api.GET("/v1/dashboard", { params: { query: { range } } })),
    refetchInterval: 60_000,
  });

  const versus = { today: t("vsYesterday"), "7d": t("vsPrevious7"), "30d": t("vsPrevious30") }[range];
  const salesLabel = { today: t("salesToday"), "7d": t("sales7"), "30d": t("sales30") }[range];

  return (
    <>
      <PageHeader
        title={t("greeting", { greeting: greeting(tz), name: firstName(me.user.name) })}
        description={me.tenant.name}
        actions={
          <>
            <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
              <TabsList aria-label={t("range")}>
                <TabsTrigger value="today">{t("today")}</TabsTrigger>
                <TabsTrigger value="7d">{t("days7")}</TabsTrigger>
                <TabsTrigger value="30d">{t("days30")}</TabsTrigger>
              </TabsList>
            </Tabs>
            {can("order:read") ? (
              <Button asChild>
                <Link href="/pesanan?status=new">
                  <ShoppingBag aria-hidden />
                  {t("processNew")}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      {dashboard.isPending ? (
        <DashboardSkeleton />
      ) : dashboard.isError ? (
        <Card>
          <ErrorState error={dashboard.error} onRetry={() => dashboard.refetch()} />
        </Card>
      ) : (
        <DashboardBody data={dashboard.data} salesLabel={salesLabel} versus={versus} timeZone={tz} />
      )}
    </>
  );
}

function DashboardBody({
  data,
  salesLabel,
  versus,
  timeZone,
}: {
  data: Dashboard;
  salesLabel: string;
  versus: string;
  timeZone: string;
}) {
  const t = useTranslations("dashboard");
  const can = useCan();
  const statuses = data.orders.statuses;
  const tasks = data.tasks.slice(0, 5);

  // manual sales channels are not in `stores` (no connection to watch); a business selling only through
  // them still gets its dashboard
  const hasOrders = Object.values(data.orders.statuses).some((n) => n > 0);
  const canManageStores = can("settings:store");
  if (data.stores.length === 0 && !hasOrders) {
    return (
      <Card>
        <EmptyState
          icon={Plug}
          title={t("noStoreTitle")}
          body={t("noStoreBody")}
          action={
            <div className="grid justify-items-center gap-4">
              <ol className="grid list-decimal gap-1 pl-5 text-left text-sm text-text-700">
                <li>{t("noStoreStep1")}</li>
                <li>{t("noStoreStep2")}</li>
                <li>{t("noStoreStep3")}</li>
              </ol>
              {canManageStores ? (
                <Button asChild>
                  <Link href="/integrasi">
                    <Plug aria-hidden />
                    {t("connectStore")}
                  </Link>
                </Button>
              ) : null}
            </div>
          }
        />
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      <section aria-label={t("kpis")} className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        {data.sales ? (
          <KpiTile
            label={salesLabel}
            value={formatRupiah(data.sales.revenue)}
            change={{ pct: data.sales.revenueChangePct, versus }}
          />
        ) : null}
        <KpiTile
          label={t("newOrders")}
          value={formatNumber(statuses.new ?? 0)}
          note={t("problemOrders", { count: statuses.problem ?? 0 })}
          href="/pesanan?status=new"
        />
        <KpiTile
          label={t("dueSoon")}
          value={formatNumber(data.orders.dueSoon)}
          note={data.orders.overdue > 0 ? t("overdue", { count: data.orders.overdue }) : t("noneOverdue")}
          tone={data.orders.overdue > 0 ? "danger" : data.orders.dueSoon > 0 ? "warning" : undefined}
          href="/pesanan?due=soon"
        />
        {data.grossProfit ? (
          <KpiTile
            label={t("grossProfit")}
            value={formatRupiah(data.grossProfit.amount)}
            note={
              data.grossProfit.costCoveragePct !== null && data.grossProfit.costCoveragePct < 100
                ? t("costCoverage", { pct: Math.round(data.grossProfit.costCoveragePct) })
                : t("fromCost")
            }
          />
        ) : data.sales ? (
          <KpiTile
            label={t("ordersInRange")}
            value={formatNumber(data.sales.orders)}
            change={{ pct: data.sales.ordersChangePct, versus }}
          />
        ) : null}
      </section>

      {tasks.length > 0 ? (
        <section aria-labelledby="tasks-title" className="grid gap-2">
          <h2 id="tasks-title" className="text-lg font-semibold text-text-900">
            {t("tasks")}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {tasks.map((task) => {
              const href =
                task.kind === "stock_critical"
                  ? criticalStockHref(data.criticalStock?.items ?? [])
                  : TASK_HREF[task.kind];
              return (
                <Card key={task.kind} size="sm">
                  <CardContent className="flex items-center gap-3">
                    <StatusPill tone={SEVERITY_TONE[task.severity]}>{formatNumber(task.count)}</StatusPill>
                    <span className="min-w-0 flex-1 text-sm text-text-900">{task.title}</span>
                    {href ? (
                      <Button asChild variant="secondary" size="sm">
                        <Link href={href}>
                          {t("open")}
                          <ArrowRight aria-hidden />
                        </Link>
                      </Button>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      ) : null}

      {data.salesChart ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("salesChart")}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.salesChart.series.length === 0 ? (
              <p className="py-10 text-center text-text-500">{t("noSales")}</p>
            ) : (
              <SalesChart dates={data.salesChart.dates} series={data.salesChart.series} timeZone={timeZone} />
            )}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {data.topProducts ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("topProducts")}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.topProducts.length === 0 ? (
                <p className="py-6 text-center text-text-500">{t("noSales")}</p>
              ) : (
                <ol className="grid gap-3">
                  {data.topProducts.slice(0, 5).map((p) => {
                    const max = data.topProducts?.[0]?.units || 1;
                    return (
                      <li key={`${p.sku}-${p.variantId}`} className="grid gap-1">
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="min-w-0 truncate text-text-900" title={p.name}>
                            {p.name}
                            {p.variantName && p.variantName !== p.name ? (
                              <span className="text-text-500"> · {p.variantName}</span>
                            ) : null}
                          </span>
                          <span className="tabular shrink-0 text-text-700">{t("units", { count: p.units })}</span>
                        </div>
                        <div className="h-2 rounded-full bg-surface-2">
                          <div
                            className="h-2 rounded-full bg-chart-1"
                            style={{ width: `${Math.max(4, (p.units / max) * 100)}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>{t("storeStatus")}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.stores.length === 0 ? <p className="text-sm text-text-500">{t("noMarketplaceStore")}</p> : null}
            <ul className="divide-y">
              {data.stores.map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-2.5">
                  <ChannelIcon channel={s.channel} className="size-5 text-[10px]" />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-sm font-medium text-text-900">{s.name}</span>
                    {s.reason ? <span className="truncate text-[13px] text-text-500">{s.reason}</span> : null}
                  </span>
                  <StatusPill tone={HEALTH_TONE[s.health]}>{t(`health_${s.health}`)}</StatusPill>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
