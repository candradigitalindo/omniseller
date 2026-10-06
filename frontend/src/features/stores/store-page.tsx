"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ExternalLink, RefreshCw, Unplug } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { channelLabel } from "@/components/common/channel";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StoreWarehouses } from "@/features/warehouses/warehouses-view";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap, unwrapWithEtag } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import { AllocationRules } from "./allocation-rules";
import { STORE_TABS, type StoreDetail, storeTabOf } from "./store-admin-meta";
import { isMarketplaceChannel, STORE_TONE, usableStore } from "./store-meta";
import { useStartAuthorization } from "./stores-view";
import { SyncLog } from "./sync-log";

type StoreUpdate = components["schemas"]["UpdateStoreDto"];
type Loaded = { data: StoreDetail; etag: string | null };

const detailKey = (id: string) => ["stores", id, "detail"] as const;

/**
 * L40 "halaman kelola" of one store: its connection (reconnect, disconnect), its marketplace warehouses, its
 * sync settings with the stock allocation rules, and its sync log. A manual sales channel has its settings only.
 */
export function StorePage({ id }: { id: string }) {
  const t = useTranslations("storeAdmin");
  const tStores = useTranslations("stores");
  const can = useCan();
  const { params, set } = useUrlParams();
  const allowed = can("settings:store");
  const store = useQuery({
    queryKey: detailKey(id),
    queryFn: () => unwrapWithEtag(api.GET("/v1/stores/{id}", { params: { path: { id } } })),
    enabled: allowed,
  });

  if (!allowed) return <PageHeader title={t("title")} description={t("noAccess")} />;
  const back = (
    <Button asChild variant="link" size="sm" className="mb-1 h-auto px-0">
      <Link href="/integrasi">
        <ArrowLeft aria-hidden />
        {t("back")}
      </Link>
    </Button>
  );
  if (store.isPending) {
    return (
      <div className="grid gap-3" aria-busy>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (store.isError) {
    return (
      <>
        {back}
        <ErrorState error={store.error} onRetry={() => store.refetch()} />
      </>
    );
  }

  const s = store.data.data;
  const manual = s.channel === "manual";
  const tab = storeTabOf(params.get("tab"), manual);
  const settings = <SettingsTab loaded={store.data} />;
  return (
    <>
      {back}
      <PageHeader
        title={s.name}
        description={[channelLabel(s.channel), manual ? null : s.externalShopId].filter(Boolean).join(" · ")}
        actions={
          manual ? null : (
            <span className="flex flex-wrap gap-1.5">
              <StatusPill tone={STORE_TONE[s.status]}>{tStores(`status_${s.status}`)}</StatusPill>
              {s.status !== "disconnected" ? (
                <StatusPill tone={s.syncMode === "live" ? "success" : "warning"}>
                  {t(s.syncMode === "live" ? "modeLive" : "modeReadOnly")}
                </StatusPill>
              ) : null}
            </span>
          )
        }
      />
      {manual ? (
        settings
      ) : (
        <Tabs value={tab} onValueChange={(v) => set({ tab: v === "koneksi" ? null : v, status: null })}>
          <TabsList
            variant="line"
            className="mb-4 w-full max-w-full justify-start overflow-x-auto border-b"
            aria-label={t("tabs")}
          >
            {STORE_TABS.map((x) => (
              <TabsTrigger key={x} value={x} className="flex-none px-3 text-[15px]">
                {t(`tab_${x}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="koneksi">
            <ConnectionTab store={s} />
          </TabsContent>
          <TabsContent value="gudang">
            <WarehousesTab store={s} />
          </TabsContent>
          <TabsContent value="pengaturan">{settings}</TabsContent>
          <TabsContent value="log">
            <SyncLog storeId={s.id} />
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[14rem_1fr] sm:gap-3">
      <dt className="text-text-500">{label}</dt>
      <dd className="text-text-900">{children}</dd>
    </div>
  );
}

/** "Koneksi": what the marketplace allows, when it last answered, and reconnecting or disconnecting. */
function ConnectionTab({ store: s }: { store: StoreDetail }) {
  const t = useTranslations("storeAdmin");
  const tz = useTimeZone();
  const start = useStartAuthorization();
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnected = s.status === "disconnected";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("connectionTitle")}</CardTitle>
        <CardDescription>{s.statusMessage ?? t(disconnected ? "disconnectedBody" : "connectionBody")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {s.failingSince ? (
          <p
            role="status"
            className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-text-900"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            {t("failingSince", { when: formatRelative(s.failingSince, tz) })}
          </p>
        ) : null}
        <dl className="grid gap-2.5 text-sm">
          <Row label={t("connectedAt")}>{s.connectedAt ? formatDateTime(s.connectedAt, tz) : "—"}</Row>
          {/* a refused or lost authorization has no end date worth showing */}
          {s.authorizationExpiresAt && usableStore(s.status) ? (
            <Row label={t("authorizationExpires")}>{formatDateTime(s.authorizationExpiresAt, tz)}</Row>
          ) : null}
          <Row label={t("lastOrders")}>
            {s.lastOrderSyncAt ? formatRelative(s.lastOrderSyncAt, tz) : disconnected ? "—" : t("firstImport")}
          </Row>
          <Row label={t("lastListings")}>{s.lastProductSyncAt ? formatRelative(s.lastProductSyncAt, tz) : "—"}</Row>
          {s.disconnectedAt ? <Row label={t("disconnectedAt")}>{formatDateTime(s.disconnectedAt, tz)}</Row> : null}
          {s.dataDeletion ? (
            <Row label={t("dataTitle")}>
              {s.dataDeletion.deletedAt
                ? t("dataDeleted", { at: formatDateTime(s.dataDeletion.deletedAt, tz) })
                : t("dataDeleting")}
            </Row>
          ) : null}
        </dl>
        <div className="flex flex-wrap gap-2">
          {isMarketplaceChannel(s.channel) ? (
            <Button
              variant={s.status === "reauth_required" ? "default" : "secondary"}
              loading={start.isPending}
              onClick={() => start.mutate({ channel: s.channel as "shopee" | "tiktokshop", storeId: s.id })}
            >
              <RefreshCw aria-hidden />
              {t(disconnected ? "connectAgain" : "reconnect")}
            </Button>
          ) : null}
          {!disconnected ? (
            <Button variant="secondary" className="text-danger" onClick={() => setDisconnecting(true)}>
              <Unplug aria-hidden />
              {t("disconnect")}
            </Button>
          ) : null}
        </div>
        <p className="text-[13px] text-text-500">{t("reconnectHint", { channel: channelLabel(s.channel) })}</p>
      </CardContent>
      <DisconnectDialog store={s} open={disconnecting} onClose={() => setDisconnecting(false)} />
    </Card>
  );
}

/**
 * "Putuskan toko" (FR-INT-07): OmniSeller stops reading and pushing; the store's open orders stop holding
 * stock. Its orders, listings, and sync log stay as history, or go for good after the seller types its name.
 */
function DisconnectDialog({ store: s, open, onClose }: { store: StoreDetail; open: boolean; onClose: () => void }) {
  const t = useTranslations("storeAdmin");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const [keepData, setKeepData] = useState(true);
  const [typed, setTyped] = useState("");
  const [revokeUrl, setRevokeUrl] = useState<string | null | undefined>(undefined);
  const close = () => {
    onClose();
    setKeepData(true);
    setTyped("");
    setRevokeUrl(undefined);
  };
  const disconnect = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/v1/stores/{id}/disconnect", { params: { path: { id: s.id } }, body: { keepData } })),
    onSuccess: (r) => {
      toast.success(t("disconnected", { store: s.name }));
      setRevokeUrl(r.revokeUrl);
      void queryClient.invalidateQueries({ queryKey: ["stores"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["stock"] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const done = revokeUrl !== undefined;
  const confirmed = keepData || typed.trim() === s.name;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("disconnectTitle", { store: s.name })}</DialogTitle>
          <DialogDescription>{done ? t("disconnectDone") : t("disconnectBody")}</DialogDescription>
        </DialogHeader>
        {done ? (
          revokeUrl ? (
            <p className="grid gap-2 text-sm text-text-700">
              {t("revokeHint", { channel: channelLabel(s.channel) })}
              <a
                href={revokeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-1.5 font-medium text-primary-600 underline-offset-2 hover:underline"
              >
                {t("revokeLink", { channel: channelLabel(s.channel) })}
                <ExternalLink className="size-4" aria-hidden />
              </a>
            </p>
          ) : null
        ) : (
          <>
            <RadioGroup
              value={keepData ? "keep" : "delete"}
              onValueChange={(v) => setKeepData(v !== "delete")}
              className="gap-2"
              aria-label={t("dataChoice")}
            >
              {(["keep", "delete"] as const).map((k) => (
                <div key={k} className="flex items-start gap-3 rounded-lg border p-3">
                  <RadioGroupItem value={k} id={`data-${k}`} className="mt-0.5" />
                  <Label htmlFor={`data-${k}`} className="grid gap-0.5 font-normal">
                    <span className="font-medium text-text-900">{t(`data_${k}`)}</span>
                    <span className="text-[13px] text-text-500">{t(`dataHint_${k}`)}</span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
            {!keepData ? (
              <div className="grid gap-1.5">
                <Label htmlFor="disconnect-name">{t("typeName", { store: s.name })}</Label>
                <Input
                  id="disconnect-name"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                />
              </div>
            ) : null}
          </>
        )}
        <DialogFooter>
          {done ? (
            <Button onClick={close}>{t("finish")}</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={close}>
                {tCommon("cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={!confirmed}
                loading={disconnect.isPending}
                onClick={() => disconnect.mutate()}
              >
                {t("disconnect")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useWarehouses() {
  return useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 5 * 60_000,
  });
}

/** "Gudang marketplace": the same mapping as the warehouses page, for this store only (L20). */
function WarehousesTab({ store: s }: { store: StoreDetail }) {
  const warehouses = useWarehouses();
  if (warehouses.isPending) return <Skeleton className="h-40" />;
  return (
    <StoreWarehouses
      storeId={s.id}
      name={s.name}
      channel={s.channel}
      warehouses={(warehouses.data?.items ?? []).filter((w) => w.active)}
    />
  );
}

/**
 * "Pengaturan sinkron": the store's name, its home warehouse, its mode (going live is the cutover of
 * Migrasi Data, with its checks and 24 hours to undo; going back is here), automatic warehouse choice, the
 * stock sent again, and the allocation rules. Every save carries the version it was read at (If-Match).
 */
function SettingsTab({ loaded }: { loaded: Loaded }) {
  const t = useTranslations("storeAdmin");
  const queryClient = useQueryClient();
  const s = loaded.data;
  const manual = s.channel === "manual";
  const warehouses = useWarehouses();
  const [name, setName] = useState(s.name);
  const [backToTest, setBackToTest] = useState(false);

  const save = useMutation({
    mutationFn: (body: StoreUpdate) =>
      unwrapWithEtag(
        api.PATCH("/v1/stores/{id}", {
          params: { path: { id: s.id } },
          body,
          ...(loaded.etag ? { headers: { "If-Match": loaded.etag } } : {}),
        }),
      ),
    onSuccess: (r, body) => {
      queryClient.setQueryData(detailKey(s.id), r);
      void queryClient.invalidateQueries({ queryKey: ["stores"], exact: true });
      if (body.syncMode) setBackToTest(false);
      toast.success(
        body.name !== undefined
          ? t("savedName")
          : body.defaultWarehouseId !== undefined
            ? t("savedWarehouse")
            : body.autoAllocate !== undefined
              ? t(body.autoAllocate ? "autoOn" : "autoOff")
              : t("savedReadOnly"),
      );
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const resync = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/inventory/resync", { body: { storeId: s.id } })),
    onSuccess: () => toast.success(t("resyncQueued")),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const typedName = name.trim();
  const nameProblem = typedName === "" ? t("nameRequired") : typedName.length > 100 ? t("nameTooLong") : null;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("generalTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form
            className="grid gap-1.5 sm:max-w-md"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!nameProblem && typedName !== s.name) save.mutate({ name: typedName });
            }}
          >
            <Label htmlFor="store-name">{t("name")}</Label>
            <span className="flex gap-2">
              <Input
                id="store-name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={nameProblem ? true : undefined}
                aria-describedby={nameProblem ? "store-name-message" : undefined}
              />
              <Button type="submit" variant="secondary" disabled={!!nameProblem || typedName === s.name}>
                {t("saveName")}
              </Button>
            </span>
            {nameProblem ? (
              <p id="store-name-message" role="alert" className="text-sm text-danger">
                {nameProblem}
              </p>
            ) : null}
          </form>
          <div className="grid gap-1.5 sm:max-w-md">
            <Label htmlFor="store-home">{t("homeWarehouse")}</Label>
            <Select
              value={s.defaultWarehouseId ?? ""}
              onValueChange={(v) => save.mutate({ defaultWarehouseId: v })}
              disabled={save.isPending}
            >
              <SelectTrigger id="store-home" className="w-full" aria-describedby="store-home-hint">
                <SelectValue placeholder={t("chooseWarehouse")} />
              </SelectTrigger>
              <SelectContent>
                {(warehouses.data?.items ?? [])
                  .filter((w) => w.active)
                  .map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p id="store-home-hint" className="text-[13px] text-text-500">
              {t(manual ? "homeHintManual" : "homeHint")}
            </p>
          </div>
        </CardContent>
      </Card>

      {manual ? null : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("syncTitle")}</CardTitle>
              <CardDescription>{t(s.syncMode === "live" ? "liveBody" : "readOnlyBody")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex flex-wrap gap-2">
                {s.syncMode === "read_only" ? (
                  <Button asChild>
                    <Link href="/migrasi?tab=pindah">{t("goLive")}</Link>
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      loading={resync.isPending}
                      disabled={!usableStore(s.status)}
                      aria-describedby={usableStore(s.status) ? undefined : "resync-hint"}
                      onClick={() => resync.mutate()}
                    >
                      <RefreshCw aria-hidden />
                      {t("resync")}
                    </Button>
                    <Button variant="secondary" onClick={() => setBackToTest(true)}>
                      {t("backToTest")}
                    </Button>
                  </>
                )}
              </div>
              {s.syncMode === "live" && !usableStore(s.status) ? (
                <p id="resync-hint" className="text-[13px] text-text-500">
                  {t("resyncNeedsConnection")}
                </p>
              ) : null}
              <div className="flex items-start justify-between gap-4 border-t pt-4">
                <Label htmlFor="auto-allocate" className="grid gap-0.5 font-normal">
                  <span className="font-medium text-text-900">{t("autoAllocate")}</span>
                  <span className="text-[13px] text-text-500">{t("autoAllocateHint")}</span>
                </Label>
                <Switch
                  id="auto-allocate"
                  checked={s.autoAllocate}
                  disabled={save.isPending}
                  onCheckedChange={(v) => save.mutate({ autoAllocate: v })}
                />
              </div>
            </CardContent>
          </Card>
          <AllocationRules store={s} />
          <Dialog open={backToTest} onOpenChange={setBackToTest}>
            <DialogContent className="sm:max-w-[480px]">
              <DialogHeader>
                <DialogTitle>{t("backToTestTitle")}</DialogTitle>
                <DialogDescription>{t("backToTestBody", { store: s.name })}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setBackToTest(false)}>
                  {t("keepLive")}
                </Button>
                <Button loading={save.isPending} onClick={() => save.mutate({ syncMode: "read_only" })}>
                  {t("backToTest")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
