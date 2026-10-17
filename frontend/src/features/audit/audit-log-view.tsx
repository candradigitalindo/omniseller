"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Cog, KeyRound, Printer, ScrollText } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { channelLabel } from "@/components/common/channel";
import { EmptyState, ErrorState, PageHeader } from "@/components/common/page";
import { initials } from "@/components/shell/user-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { formatDate, formatDateTime, formatNumber, formatRupiah } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import {
  AUDIT_KINDS,
  type AuditChange,
  type AuditEntry,
  type AuditGroup,
  type AuditKind,
  auditKindOf,
  DATE_FIELDS,
  DELTA_FIELDS,
  daysValue,
  FILE_FIELDS,
  fieldName,
  fileChangeKey,
  GROUP_COLLAPSE_AT,
  GROUP_PREVIEW,
  groupEntries,
  MOMENT_FIELDS,
  MONEY_FIELDS,
  PERIODS,
  periodFrom,
  periodOf,
  plainValue,
  rulePhrases,
  shownChanges,
  titleKey,
  valueKey,
  weekValue,
} from "./audit-meta";

const PAGE = 50;
const ALL = "all";
/** The shape of an id, so a mangled address never reaches the api (which checks ids itself). */
const ID = /^[0-9A-Z]{26}$/;

/**
 * Log Audit (PRD FR-USR-04, UI L41a): who changed what and when, newest first, one block per action. The
 * api names the records and the people (backend doc 8.28), so Admins, who cannot list the team, still see
 * names; cost prices stay hidden without finance:read.
 */
export function AuditLogView() {
  const t = useTranslations("audit");
  const can = useCan();
  const allowed = can("audit:read");
  const { params, set } = useUrlParams();
  const kind = auditKindOf(params.get("kind"));
  const actorParam = params.get("actor");
  const actor = actorParam && ID.test(actorParam) ? actorParam : null;
  const period = periodOf(params.get("period"));
  const people = useQuery({
    queryKey: ["audit", "people"],
    queryFn: () => unwrap(api.GET("/v1/audit-logs/people")),
    enabled: allowed,
  });
  const log = useInfiniteQuery({
    queryKey: ["audit", "log", kind, actor, period],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/audit-logs", {
          params: {
            query: {
              limit: PAGE,
              ...(kind ? { entity_type: AUDIT_KINDS[kind].join(",") } : {}),
              ...(actor ? { actor_id: actor } : {}),
              ...(period ? { from: periodFrom(period) } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: allowed,
  });
  const entries = log.data?.pages.flatMap((p) => p.items) ?? [];
  const lastEmpty = log.data?.pages.at(-1)?.items.length === 0;
  // a page ends early after many rows nobody would recognise: read on by itself rather than show nothing
  useEffect(() => {
    if (lastEmpty && log.hasNextPage && !log.isFetchingNextPage) void log.fetchNextPage();
  }, [lastEmpty, log.hasNextPage, log.isFetchingNextPage, log.fetchNextPage]);

  if (!allowed) return <PageHeader title={t("title")} description={t("noAccess")} />;
  const filtered = kind !== null || actor !== null || period !== null;
  const groups = groupEntries(entries);

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={kind ?? ALL} onValueChange={(v) => set({ kind: v === ALL ? null : v })}>
          <SelectTrigger className="h-10 w-56" aria-label={t("filterKind")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allKinds")}</SelectItem>
            {(Object.keys(AUDIT_KINDS) as AuditKind[]).map((k) => (
              <SelectItem key={k} value={k}>
                {t(`kind_${k}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={actor ?? ALL} onValueChange={(v) => set({ actor: v === ALL ? null : v })}>
          <SelectTrigger className="h-10 w-48" aria-label={t("filterActor")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allActors")}</SelectItem>
            {(people.data?.items ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={period ?? ALL} onValueChange={(v) => set({ period: v === ALL ? null : v })}>
          <SelectTrigger className="h-10 w-44" aria-label={t("filterPeriod")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p} value={p}>
                {t(`period_${p}`)}
              </SelectItem>
            ))}
            <SelectItem value={ALL}>{t("periodAll")}</SelectItem>
          </SelectContent>
        </Select>
        {filtered ? (
          <Button variant="ghost" size="sm" onClick={() => set({ kind: null, actor: null, period: null })}>
            {t("clearFilters")}
          </Button>
        ) : null}
      </div>
      <Card className="gap-0 py-0">
        {log.isPending || (lastEmpty && log.hasNextPage && entries.length === 0) ? (
          <div className="grid gap-3 p-4" aria-busy>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : log.isError ? (
          <ErrorState error={log.error} onRetry={() => log.refetch()} />
        ) : entries.length === 0 ? (
          <EmptyState icon={ScrollText} title={filtered ? t("emptyFiltered") : t("empty")} />
        ) : (
          <ol className="divide-y" aria-label={t("title")}>
            {groups.map((g) => (
              <GroupItem key={g.key} group={g} />
            ))}
          </ol>
        )}
      </Card>
      {log.hasNextPage && entries.length > 0 ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" loading={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>
            {t("loadMore")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function ActorMark({ actor }: { actor: AuditEntry["actor"] }) {
  const Icon = actor.type === "device" ? Printer : actor.type === "api_key" ? KeyRound : Cog;
  return (
    <Avatar className="size-8 shrink-0">
      <AvatarFallback className="bg-primary-100 text-sm font-semibold text-primary-600">
        {actor.type === "user" ? initials(actor.name ?? "?") : <Icon className="size-4" aria-hidden />}
      </AvatarFallback>
    </Avatar>
  );
}

function useActorName() {
  const t = useTranslations("audit");
  return (actor: AuditEntry["actor"]) => {
    if (actor.type === "user") return actor.name ?? t("unknownUser");
    if (actor.type === "device") return actor.name ? t("device", { name: actor.name }) : t("deviceUnknown");
    return actor.type === "api_key" ? t("apiKey") : t("system");
  };
}

/** One action: who, when, and each record it changed; a long one (a signup's roles) folds after three. */
function GroupItem({ group }: { group: AuditGroup }) {
  const t = useTranslations("audit");
  const tz = useTimeZone();
  const actorName = useActorName();
  const [open, setOpen] = useState(false);
  const head = group.entries[0]!;
  const folds = group.entries.length > GROUP_COLLAPSE_AT;
  const shown = folds && !open ? group.entries.slice(0, GROUP_PREVIEW) : group.entries;
  return (
    <li className="flex gap-3 p-4">
      <ActorMark actor={head.actor} />
      <div className="grid min-w-0 flex-1 gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-sm font-semibold text-text-900">{actorName(head.actor)}</span>
          <time dateTime={head.at} className="text-[13px] whitespace-nowrap text-text-500">
            {formatDateTime(head.at, tz)}
          </time>
        </div>
        <ul className="grid gap-2">
          {shown.map((e) => (
            <EntryLine key={e.id} entry={e} />
          ))}
        </ul>
        {folds ? (
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? t("lessInGroup") : t("moreInGroup", { count: group.entries.length - GROUP_PREVIEW })}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function EntryLine({ entry: e }: { entry: AuditEntry }) {
  const t = useTranslations("audit");
  const tz = useTimeZone();
  const valueText = useValueText();
  const title = t(`title_${titleKey(e)}`);
  const changes = shownChanges(e);
  const label = (field: string) => {
    const known = fieldName(field);
    return known ? t(`field_${known}`) : field;
  };
  const text = (c: AuditChange) => {
    if (c.hidden) return t("hidden");
    if (FILE_FIELDS.has(c.field)) {
      if (e.change === "created") return t("fileAdded");
      if (e.change === "deleted") return t("fileRemoved");
      return t(fileChangeKey(c.before, c.after));
    }
    const v = (x: unknown) => valueText(e.entityType, c.field, x);
    if (e.change === "updated") return `${v(c.before)} → ${v(c.after)}`;
    return v(e.change === "deleted" ? c.before : c.after);
  };
  return (
    <li className="grid gap-1">
      <p className="text-sm text-text-900">
        {title}
        {e.label ? (
          <span className="font-semibold">
            {" "}
            {/* a courier holiday is named by its date */}
            {/^\d{4}-\d{2}-\d{2}$/.test(e.label) ? formatDate(e.label, tz) : e.label}
          </span>
        ) : null}
      </p>
      {changes.length > 0 ? (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-text-700">
          {changes.map((c) => (
            <div key={c.field} className="flex min-w-0 flex-wrap gap-1">
              <dt className="text-text-500">{label(c.field)}:</dt>
              <dd className="min-w-0 break-words">{text(c)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

/** A value as the seller reads it: Rupiah, signed quantities, local times, and coded values by name. */
function useValueText() {
  const t = useTranslations("audit");
  const tAll = useTranslations();
  const tz = useTimeZone();
  return (entityType: string, field: string, value: unknown): string => {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "boolean") return value ? t("yes") : t("no");
    // courier days and weekly hours (backend doc 8.31) read as days, not numbers
    if (field === "daysOfWeek") return daysValue(value) ?? plainValue(value);
    if (field === "cutoffTime" && typeof value === "string") return value.slice(0, 5).replace(":", ".");
    if (field === "schedule") return weekValue(value, t("closedDay")) ?? plainValue(value);
    // an automatic rule's conditions and actions (backend doc 8.37) as short phrases
    const rule = entityType === "order_rule" ? rulePhrases(field, value) : null;
    if (rule) {
      return rule
        .map((p) =>
          t(p.key, {
            ...p.values,
            ...(typeof p.values.min === "number" ? { min: formatRupiah(p.values.min) } : {}),
            ...(typeof p.values.max === "number" ? { max: formatRupiah(p.values.max) } : {}),
          }),
        )
        .join(" · ");
    }
    if (typeof value === "number") {
      if (MONEY_FIELDS.has(field)) return formatRupiah(value);
      if (DELTA_FIELDS.has(field) && value > 0) return `+${formatNumber(value)}`;
      return formatNumber(value);
    }
    if (typeof value === "string") {
      if (entityType === "affiliate_product_query" && field === "status")
        return tAll(`affiliate.request_${value}` as never);
      if (entityType === "listing_price_change" && field === "status")
        return tAll(`listingPrices.status_${value}` as never);
      if (MOMENT_FIELDS.has(field) && !Number.isNaN(Date.parse(value))) return formatDateTime(value, tz);
      if (DATE_FIELDS.has(field) && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value, tz);
      if (field === "channel") return channelLabel(value);
      // coded values are named by the screens that set them; the key comes from data, so it is checked first
      const key = valueKey(entityType, field, value) as never;
      if (key && tAll.has(key)) return tAll(key);
    }
    return plainValue(value);
  };
}
