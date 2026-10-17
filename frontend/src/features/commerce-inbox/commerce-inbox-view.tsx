"use client";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, MessageCircle, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useCan, useSession, useTimeZone } from "@/lib/session";
import { INBOX_UPLOAD_OPERATION, INBOX_VIDEO_OPERATION, type InboxConversation } from "./contracts";
import { ConversationDialog } from "./conversation-dialog";
import { useInboxPage } from "./hooks";
import { InboxStatus } from "./inbox-status";
import { NewConversationDialog } from "./new-conversation-dialog";

export function CommerceInboxView() {
  const t = useTranslations("commerceInbox");
  const can = useCan();
  const session = useSession();
  const zone = useTimeZone();
  const accessKey = JSON.stringify([
    session.tenant.id,
    session.permissions,
    session.storeScope,
    session.warehouseScope,
  ]);
  const [principalId, setPrincipalId] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [conversation, setConversation] = useState<InboxConversation>();
  const [creating, setCreating] = useState(false);
  const allowed = can("chat:read") && can("commerce:read");
  const accounts = useQuery({
    queryKey: ["commerce-inbox", "principals", accessKey],
    queryFn: () => unwrap(api.GET("/v1/commerce/principals")),
    enabled: allowed,
  });
  const catalog = useQuery({
    queryKey: ["commerce", "operations"],
    queryFn: () => unwrap(api.GET("/v1/commerce/operations")),
    enabled: allowed,
  });
  const sellers = accounts.data?.items.filter((item) => item.kind === "seller") ?? [];
  const principal =
    sellers.find((item) => item.id === principalId) ??
    sellers.find((item) => item.channel === "tiktokshop") ??
    sellers[0];
  const reason =
    principal?.channel === "shopee"
      ? "unsupported"
      : principal && !principal.scopes.includes("seller.customer_service")
        ? "scopeMissing"
        : principal && principal.status !== "active"
          ? "inactive"
          : session.warehouseScope !== null
            ? "warehouseScope"
            : null;
  const conversations = useInboxPage(
    "conversations",
    allowed && !reason ? principal?.id : undefined,
    undefined,
    cursors.at(-1),
    refresh,
    accessKey,
  );
  const rows =
    conversations.data?.conversations.filter((row) =>
      `${row.name} ${row.preview} ${row.id}`.toLocaleLowerCase("id").includes(search.toLocaleLowerCase("id")),
    ) ?? [];
  if (!allowed) return <PageHeader title={t("title")} description={t("noAccess")} />;
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          <Button variant="secondary" size="sm" asChild>
            <Link href="/commerce">
              {t("backCommerce")}
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        }
      />
      {accounts.isPending ? (
        <div role="status">
          <Skeleton className="h-24" />
          <p className="mt-2 text-sm text-text-500">{t("loadingAccounts")}</p>
        </div>
      ) : accounts.isError ? (
        <ErrorState error={accounts.error} onRetry={() => accounts.refetch()} />
      ) : !principal ? (
        <EmptyState
          icon={MessageCircle}
          title={t("noAccounts")}
          action={
            <Button asChild>
              <Link href="/integrasi">{t("connect")}</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid min-w-0 gap-4">
          <div className="grid min-w-0 gap-1.5">
            <label htmlFor="inbox-store" className="text-sm font-medium">
              {t("store")}
            </label>
            <Select
              value={principal.id}
              onValueChange={(value) => {
                setPrincipalId(value);
                setCursors([]);
                setSearch("");
                setConversation(undefined);
              }}
            >
              <SelectTrigger id="inbox-store" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sellers.map((seller) => (
                  <SelectItem key={seller.id} value={seller.id}>
                    {seller.name} · {seller.channel === "shopee" ? "Shopee" : "Tokopedia & Shop"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {reason ? (
            <p role="status" className="rounded-xl border border-border bg-surface-2 p-4 text-sm">
              {t(reason)}
            </p>
          ) : (
            <>
              <div className="flex min-w-0 gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute top-3 left-3 size-4 text-text-500" aria-hidden />
                  <Input
                    type="search"
                    className="pl-9"
                    aria-label={t("search")}
                    placeholder={t("search")}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label={t("refresh")}
                  disabled={conversations.loading}
                  onClick={() => {
                    setCursors([]);
                    setRefresh((value) => value + 1);
                  }}
                >
                  <RefreshCw aria-hidden />
                </Button>
              </div>
              <p className="text-xs text-text-500">{t("searchHint")}</p>
              {conversations.error ? (
                <ErrorState error={conversations.error} onRetry={() => setRefresh((value) => value + 1)} />
              ) : null}
              {conversations.loading || ["failed", "uncertain"].includes(conversations.data?.status ?? "") ? (
                <InboxStatus loading={conversations.loading} status={conversations.data?.status} />
              ) : null}
              {principal.readOnly ? <p className="text-sm text-text-500">{t("readOnly")}</p> : null}
              {!conversations.loading && conversations.data?.status === "succeeded" && !rows.length ? (
                <Card className="p-6 text-center text-sm text-text-500">{t(search ? "noMatch" : "empty")}</Card>
              ) : null}
              {can("chat:write") && can("commerce:write") && !principal.readOnly ? (
                <Button variant="secondary" size="sm" className="justify-self-start" onClick={() => setCreating(true)}>
                  <MessageCircle aria-hidden />
                  {t("newConversation")}
                </Button>
              ) : null}
              <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map((row) => {
                  const name = row.name || t("conversation", { id: row.id.slice(-6) });
                  return (
                    <button
                      key={row.id}
                      type="button"
                      className="grid min-w-0 gap-2 rounded-xl border border-border bg-surface-1 p-4 text-left transition hover:border-primary focus-visible:outline-2 focus-visible:outline-primary"
                      aria-label={t("open", { name })}
                      onClick={() => setConversation(row)}
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
                        {row.unread ? <StatusPill tone="info">{t("unread", { count: row.unread })}</StatusPill> : null}
                      </div>
                      <p className="line-clamp-2 min-w-0 text-sm text-text-500 break-words">
                        {row.preview || t("noPreview")}
                      </p>
                      {row.updatedAt ? (
                        <time className="text-xs text-text-500" dateTime={row.updatedAt}>
                          {formatDateTime(row.updatedAt, zone)}
                        </time>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-between gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!cursors.length || conversations.loading}
                  onClick={() => {
                    setCursors((items) => items.slice(0, -1));
                    setSearch("");
                  }}
                >
                  {t("previous")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!conversations.data?.nextCursor || conversations.loading}
                  onClick={() => {
                    setCursors((items) => [...items, conversations.data!.nextCursor!]);
                    setSearch("");
                  }}
                >
                  {t("next")}
                </Button>
              </div>
            </>
          )}
          {creating && !reason ? (
            <NewConversationDialog
              principalId={principal.id}
              accessKey={accessKey}
              onClose={() => {
                setCreating(false);
                setCursors([]);
                setRefresh((value) => value + 1);
              }}
            />
          ) : null}
          {conversation && !reason ? (
            <ConversationDialog
              key={`${principal.id}:${conversation.id}`}
              principal={principal}
              conversation={conversation}
              accessKey={accessKey}
              canWrite={can("chat:write") && can("commerce:write")}
              imageOperation={catalog.data?.items.find((operation) => operation.id === INBOX_UPLOAD_OPERATION)}
              videoOperation={catalog.data?.items.find((operation) => operation.id === INBOX_VIDEO_OPERATION)}
              onClose={() => setConversation(undefined)}
            />
          ) : null}
        </div>
      )}
    </>
  );
}
