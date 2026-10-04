"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { AlertOctagon, AlertTriangle, Bell, Info } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { returnNoticeHref } from "@/features/returns/return-meta";
import { criticalStockHref } from "@/features/stock/stock-meta";
import { api, unwrap } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { formatDate, formatRelative } from "@/lib/format";
import { useSession } from "@/lib/session";

type Notice = components["schemas"]["NotificationPageDto_Output"]["items"][number];

/** Where a notification leads, by its kind (backend doc 8.17); unknown kinds only mark it read. */
/** The SKUs a stock alert names (`data.items`, backend stock-alerts.service). */
function stockItems(data: unknown): { sku: string }[] {
  const items = (data as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items.filter((i): i is { sku: string } => typeof i?.sku === "string") : [];
}

export function noticeHref(notice: Pick<Notice, "kind" | "data">): string | null {
  switch (notice.kind) {
    case "order.new":
      return "/pesanan?status=new";
    case "order.sla":
      return "/pesanan?due=soon";
    case "stock.critical":
      return criticalStockHref(stockItems(notice.data));
    case "return.new":
    case "return.due_soon":
    case "return.parcel_back":
      return returnNoticeHref(notice.kind, notice.data);
    default:
      return null;
  }
}

const SEVERITY_ICON = { info: Info, warning: AlertTriangle, critical: AlertOctagon } as const;
const SEVERITY_CLASS = { info: "text-primary-600", warning: "text-warning", critical: "text-danger" } as const;

/** The bell of the top bar (L52): unread count, the latest notifications grouped Today and Earlier. */
export function Notifications() {
  const t = useTranslations("shell");
  const me = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const tz = me.tenant.timezone;

  const unread = useQuery({
    queryKey: ["notifications", "unread"],
    queryFn: () => unwrap(api.GET("/v1/notifications/unread-count")),
    refetchInterval: 60_000,
  });
  const list = useQuery({
    queryKey: ["notifications", "list"],
    queryFn: () => unwrap(api.GET("/v1/notifications", { params: { query: { limit: 30 } } })),
    enabled: open,
  });
  const markRead = useMutation({
    mutationFn: (body: { ids?: string[]; all?: boolean }) => unwrap(api.POST("/v1/notifications/read", { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const count = unread.data?.unread ?? 0;
  const items = list.data?.items ?? [];
  const today = formatDate(new Date(), tz);
  const groups = [
    { label: t("today"), items: items.filter((n) => formatDate(n.createdAt, tz) === today) },
    { label: t("earlier"), items: items.filter((n) => formatDate(n.createdAt, tz) !== today) },
  ].filter((g) => g.items.length > 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={t("notifications")}>
          <Bell />
          {count > 0 ? (
            <span className="absolute top-1.5 right-1.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[11px] leading-4 font-semibold text-white">
              {count > 99 ? "99+" : count}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(400px,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold text-text-900">{t("notifications")}</h2>
          <Button
            variant="link"
            size="sm"
            disabled={count === 0 || markRead.isPending}
            onClick={() => markRead.mutate({ all: true })}
          >
            {t("markAllRead")}
          </Button>
        </div>
        <ScrollArea className="max-h-[60vh]">
          {groups.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-text-500">{list.isPending ? "…" : t("noNotifications")}</p>
          ) : (
            groups.map((g) => (
              <section key={g.label} className="py-1">
                <h3 className="px-4 pt-2 pb-1 text-[13px] font-medium text-text-500">{g.label}</h3>
                <ul>
                  {g.items.map((n) => {
                    const Icon = SEVERITY_ICON[n.severity];
                    const href = noticeHref(n);
                    return (
                      <li key={n.id}>
                        <button
                          type="button"
                          className={cn(
                            "flex w-full gap-3 px-4 py-2.5 text-left hover:bg-surface-2",
                            !n.readAt && "bg-primary-50",
                          )}
                          onClick={() => {
                            if (!n.readAt) markRead.mutate({ ids: [n.id] });
                            if (href) {
                              setOpen(false);
                              router.push(href);
                            }
                          }}
                        >
                          <Icon className={cn("mt-0.5 size-5 shrink-0", SEVERITY_CLASS[n.severity])} aria-hidden />
                          <span className="grid min-w-0 gap-0.5">
                            <span className="text-sm font-medium text-text-900">{n.title}</span>
                            <span className="line-clamp-2 text-[13px] text-text-700">{n.body}</span>
                            <span className="text-[13px] text-text-500">{formatRelative(n.createdAt, tz)}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
