"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, Mail } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { KpiTile } from "@/components/common/kpi";
import { EmptyState, ErrorState, PageHeader } from "@/components/common/page";
import { Segmented } from "@/components/common/segmented";
import { initials } from "@/components/shell/user-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { formatNumber } from "@/lib/format";
import { useCan, useHasFeature, useSession, useTimeZone } from "@/lib/session";
import {
  formatLocalDate,
  formatRange,
  PERIODS,
  type Period,
  packMinutes,
  periodOf,
  periodRange,
  type StaffFigures,
  type StaffQuery,
  type StaffReport,
  type StaffSection,
  staffDays,
  staffExportHref,
  staffWorkbookHref,
  todayIn,
} from "./report-meta";
import { CustomPeriod, type RankColumn, RankTable } from "./report-parts";

const ALL = "all";
const SECTIONS: readonly StaffSection[] = ["users", "days"];

/**
 * L33 Kinerja Tim (DOKUMEN-UI-UX 14.6, backend 8.35, PRD FR-RPT-10), from plan Growth on: what each member did
 * to orders in OmniSeller, per member and per day: orders processed, packed (by scan), labels, pick lists,
 * packing lists, parcels handed to couriers, and minutes per order packed by scan. Only actions inside
 * OmniSeller count. For whoever manages the team (`settings:user`).
 */
export function StaffReportView() {
  const t = useTranslations("staffReport");
  const tReports = useTranslations("reports");
  const can = useCan();
  const me = useSession();
  const featured = useHasFeature("staff_report");
  const tz = useTimeZone();
  const { params, set } = useUrlParams();
  const period = periodOf(params.get("period"));
  const custom = { from: params.get("from") ?? "", to: params.get("to") ?? "" };
  const today = todayIn(tz);
  const range = periodRange(period, today, custom);
  const query: StaffQuery | null = range ? { from: range.from, to: range.to } : null;
  const allowed = can("settings:user");

  const report = useQuery({
    queryKey: ["reports", "staff", query],
    queryFn: () => unwrap(api.GET("/v1/reports/staff", { params: { query: query ?? {} } })),
    enabled: allowed && featured && query !== null,
    placeholderData: keepPreviousData,
  });

  if (!allowed) return <PageHeader title={t("title")} description={t("noAccess")} />;
  if (!featured) {
    return (
      <>
        <PageHeader title={t("title")} description={t("description")} />
        <Card>
          <CardHeader>
            <CardTitle>{t("lockedTitle")}</CardTitle>
            <CardDescription>
              {t("locked", { plan: me.plan.name })}
              {can("settings:billing") ? (
                <>
                  {" "}
                  <Link href="/langganan" className="font-medium text-primary hover:underline">
                    {t("seePlans")}
                  </Link>
                </>
              ) : null}
            </CardDescription>
          </CardHeader>
        </Card>
      </>
    );
  }

  const choosePeriod = (p: Period) => {
    if (p === "custom") set({ period: p, from: range?.from ?? today, to: range?.to ?? today });
    else set({ period: p === "month" ? null : p, from: null, to: null });
  };

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          query ? (
            <>
              <Button asChild variant="ghost">
                <Link href="/notifikasi">
                  <Mail aria-hidden />
                  {t("scheduleEmail")}
                </Link>
              </Button>
              <DownloadMenu query={query} />
            </>
          ) : null
        }
      />

      <div className="-mx-4 mb-3 w-[calc(100%+2rem)] overflow-x-auto px-4 md:mx-0 md:w-auto md:px-0">
        <Segmented
          label={tReports("period")}
          value={period}
          onChange={choosePeriod}
          options={PERIODS.map((p) => ({ value: p, label: tReports(`period_${p}`) }))}
        />
      </div>

      {period === "custom" ? (
        <CustomPeriod
          key={`${custom.from}|${custom.to}`}
          initial={custom}
          onApply={(r) => set({ period: "custom", from: r.from, to: r.to })}
        />
      ) : null}

      {!query ? (
        <Card>
          <EmptyState title={tReports("pickDates")} />
        </Card>
      ) : report.isPending ? (
        <StaffSkeleton />
      ) : report.isError ? (
        <Card>
          <ErrorState error={report.error} onRetry={() => report.refetch()} />
        </Card>
      ) : (
        <StaffBody report={report.data} member={params.get("member")} onMember={(id) => set({ member: id })} />
      )}
    </>
  );
}

function StaffSkeleton() {
  return (
    <div className="grid gap-4" aria-busy>
      <Skeleton className="h-5 w-72" />
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-80" />
    </div>
  );
}

/** Both tables as one Excel workbook, or per member or per member per day as CSV, for the period on screen. */
function DownloadMenu({ query }: { query: StaffQuery }) {
  const t = useTranslations("staffReport");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary">
          <Download aria-hidden />
          {t("download")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <a href={staffWorkbookHref(query)} download>
            {t("downloadXlsx")}
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {SECTIONS.map((s) => (
          <DropdownMenuItem key={s} asChild>
            <a href={staffExportHref(s, query)} download>
              {t(`section_${s}`)}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StaffBody({
  report,
  member,
  onMember,
}: {
  report: StaffReport;
  member: string | null;
  onMember: (id: string | null) => void;
}) {
  const t = useTranslations("staffReport");
  const columns = useFigureColumns();
  const nameOf = (u: { name: string | null }) => u.name ?? t("unknownMember");
  // a member from an old link who did nothing in this period shows the whole team
  const chosen = member && report.users.some((u) => u.userId === member) ? member : null;
  const pack = packMinutes(report.total.packSecondsAverage);
  const caption = <p className="text-sm text-text-500">{t("caption", { range: formatRange(report.range) })}</p>;

  if (report.users.length === 0) {
    return (
      <div className="grid gap-4">
        {caption}
        <Card>
          <EmptyState title={t("empty")} body={t("emptyBody")} />
        </Card>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {caption}
      <section aria-label={t("kpis")} className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        <KpiTile label={t("kpiProcessed")} value={formatNumber(report.total.processed)} />
        <KpiTile
          label={t("kpiPacked")}
          value={formatNumber(report.total.packed)}
          note={t("kpiPackedNote", { scan: report.total.packedByScan })}
        />
        <KpiTile label={t("kpiHandedOver")} value={formatNumber(report.total.handedOver)} />
        <KpiTile
          label={t("kpiPackTime")}
          value={pack ? t("kpiPackTimeValue", { minutes: pack }) : "—"}
          note={pack ? t("kpiPackTimeNote", { count: report.total.timedPacks }) : t("noPackTime")}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>{t("membersTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <RankTable
            rows={report.users}
            rowKey={(u) => u.userId}
            nameHeader={t("member")}
            name={(u) => <MemberName name={nameOf(u)} />}
            measure={(u) => u.processed}
            columns={columns}
            scrollLabel={t("membersTitle")}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("daysTitle")}</CardTitle>
          <CardAction>
            <Select value={chosen ?? ALL} onValueChange={(v) => onMember(v === ALL ? null : v)}>
              <SelectTrigger className="h-10 w-56" aria-label={t("member")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("allMembers")}</SelectItem>
                {report.users.map((u) => (
                  <SelectItem key={u.userId} value={u.userId}>
                    {nameOf(u)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardAction>
        </CardHeader>
        <CardContent>
          <RankTable
            rows={staffDays(report, chosen)}
            rowKey={(d) => d.date}
            nameHeader={t("date")}
            name={(d) => formatLocalDate(d.date)}
            measure={(d) => d.processed}
            columns={columns}
            scrollLabel={t("daysTitle")}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("legend")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <ul className="grid gap-1.5 text-text-700">
            <li>{t("legendProcessed")}</li>
            <li>{t("legendPacked")}</li>
            <li>{t("legendLabels")}</li>
            <li>{t("legendPickLists")}</li>
            <li>{t("legendPackingLists")}</li>
            <li>{t("legendHandedOver")}</li>
            <li>{t("legendPackMinutes", { limit: report.packTimeLimitSeconds / 60 })}</li>
          </ul>
          <p className="text-text-500">{t("note")}</p>
        </CardContent>
      </Card>
    </div>
  );
}

/** The figures both tables show, in L33's order. */
function useFigureColumns(): RankColumn<StaffFigures>[] {
  const t = useTranslations("staffReport");
  return [
    { key: "processed", header: t("colProcessed"), cell: (f) => formatNumber(f.processed) },
    {
      key: "packed",
      header: t("colPacked"),
      cell: (f) =>
        f.packedByScan > 0 ? (
          <>
            {formatNumber(f.packed)}{" "}
            <span className="text-text-500">({t("packedScan", { count: f.packedByScan })})</span>
          </>
        ) : (
          formatNumber(f.packed)
        ),
    },
    { key: "labels", header: t("colLabels"), cell: (f) => formatNumber(f.labels) },
    { key: "pickLists", header: t("colPickLists"), cell: (f) => formatNumber(f.pickLists) },
    { key: "packingLists", header: t("colPackingLists"), cell: (f) => formatNumber(f.packingLists) },
    { key: "handedOver", header: t("colHandedOver"), cell: (f) => formatNumber(f.handedOver) },
    { key: "packMinutes", header: t("colPackMinutes"), cell: (f) => packMinutes(f.packSecondsAverage) ?? "—" },
  ];
}

function MemberName({ name }: { name: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar className="size-7 shrink-0" aria-hidden>
        <AvatarFallback className="bg-primary-100 text-xs font-semibold text-primary-600">
          {initials(name)}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{name}</span>
    </span>
  );
}
