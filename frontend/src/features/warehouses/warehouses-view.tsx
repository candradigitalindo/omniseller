"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, MapPin, Plus, RefreshCw, Star, Warehouse as WarehouseIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ChannelIcon } from "@/components/common/channel";
import { Field, fieldProps } from "@/components/common/field";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useStores } from "@/features/stores/use-store-modes";
import { api, unwrap, unwrapWithEtag } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { PROVINCES } from "@/lib/region";
import { useCan } from "@/lib/session";
import {
  addressLines,
  type ChannelWarehouse,
  emptyForm,
  formOf,
  MAPPING_TONE,
  type Warehouse,
  type WarehouseForm,
  warehouseBody,
  warehouseProblems,
} from "./warehouse-meta";

const NONE = "none";

/**
 * L20 Gudang dan Pemetaan Gudang Marketplace (DOKUMEN-UI-UX 14.4, backend 8.21): the physical warehouses with
 * their address (the sender on manual labels, the province for allocation), and every marketplace warehouse
 * mapped to one of them; a store with an unmapped warehouse stops its stock sync.
 */
export function WarehousesView() {
  const t = useTranslations("warehouses");
  const can = useCan();
  const [editing, setEditing] = useState<Warehouse | "new" | null>(null);
  const list = useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    enabled: can("inventory:read"),
  });
  if (!can("inventory:read")) return <PageHeader title={t("title")} description={t("noAccess")} />;
  const manage = can("settings:warehouse");
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          manage ? (
            <Button onClick={() => setEditing("new")}>
              <Plus aria-hidden />
              {t("add")}
            </Button>
          ) : null
        }
      />
      {list.isPending ? (
        <div className="grid gap-3 md:grid-cols-2" aria-busy>
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : list.isError ? (
        <Card>
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {list.data.items.map((w) => (
            <li key={w.id}>
              <WarehouseCard warehouse={w} manage={manage} onEdit={() => setEditing(w)} />
            </li>
          ))}
        </ul>
      )}
      {can("settings:store") && list.data ? <ChannelWarehouses warehouses={list.data.items} /> : null}
      {editing ? (
        <WarehouseDialog warehouse={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}

function WarehouseCard({
  warehouse: w,
  manage,
  onEdit,
}: {
  warehouse: Warehouse;
  manage: boolean;
  onEdit: () => void;
}) {
  const t = useTranslations("warehouses");
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["stock", "warehouses"] });
  const makeDefault = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/warehouses/{id}/default", { params: { path: { id: w.id } } })),
    onSuccess: () => {
      toast.success(t("defaultSet", { name: w.name }));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/warehouses/{id}", { params: { path: { id: w.id } } })),
    onSuccess: () => {
      toast.success(t("deleted", { name: w.name }));
      setConfirm(false);
      refresh();
    },
  });
  const lines = addressLines(w.address);
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <WarehouseIcon className="size-5 text-primary" aria-hidden />
          {w.name}
          <span className="font-mono text-sm font-normal text-text-500">{w.code}</span>
          {w.isDefault ? (
            <StatusPill tone="info" icon={Star}>
              {t("default")}
            </StatusPill>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {lines.length > 0 ? (
          <p className="flex items-start gap-2 text-sm text-text-700">
            <MapPin className="mt-0.5 size-4 shrink-0 text-text-500" aria-hidden />
            <span className="grid">
              {lines.map((l) => (
                <span key={l}>{l}</span>
              ))}
            </span>
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-warning">
            <AlertTriangle className="size-4" aria-hidden />
            {t("noAddress")}
          </p>
        )}
        {manage ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={onEdit}>
              {t("edit")}
            </Button>
            {!w.isDefault ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={makeDefault.isPending}
                  onClick={() => makeDefault.mutate()}
                >
                  {t("makeDefault")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
                  {t("delete")}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </CardContent>
      <Dialog open={confirm} onOpenChange={(v) => !v && setConfirm(false)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("deleteTitle", { name: w.name })}</DialogTitle>
            <DialogDescription>{t("deleteBody", { code: w.code })}</DialogDescription>
          </DialogHeader>
          {remove.isError ? (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
              {errorMessage(remove.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" loading={remove.isPending} onClick={() => remove.mutate()}>
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Add a warehouse, or change one with If-Match so two people editing it do not overwrite each other. */
function WarehouseDialog({ warehouse, onClose }: { warehouse: Warehouse | null; onClose: () => void }) {
  const t = useTranslations("warehouses");
  const fresh = useQuery({
    queryKey: ["stock", "warehouses", "detail", warehouse?.id],
    queryFn: () => unwrapWithEtag(api.GET("/v1/warehouses/{id}", { params: { path: { id: warehouse?.id ?? "" } } })),
    enabled: warehouse !== null,
    staleTime: 0,
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{warehouse ? t("editTitle", { name: warehouse.name }) : t("addTitle")}</DialogTitle>
          <DialogDescription>{t("formBody")}</DialogDescription>
        </DialogHeader>
        {warehouse && fresh.isPending ? (
          <Skeleton className="h-64" />
        ) : (
          <WarehouseFormBody
            key={fresh.data?.etag ?? "new"}
            initial={warehouse ? formOf(fresh.data?.data ?? warehouse) : emptyForm()}
            id={warehouse?.id ?? null}
            etag={fresh.data?.etag ?? null}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function WarehouseFormBody({
  initial,
  id,
  etag,
  onClose,
}: {
  initial: WarehouseForm;
  id: string | null;
  etag: string | null;
  onClose: () => void;
}) {
  const t = useTranslations("warehouses");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<WarehouseForm>) => setF((x) => ({ ...x, ...patch }));
  const save = useMutation({
    mutationFn: () => {
      const body = warehouseBody(f);
      return id
        ? unwrap(
            api.PATCH("/v1/warehouses/{id}", {
              params: { path: { id } },
              ...(etag ? { headers: { "If-Match": etag } } : {}),
              body,
            }),
          )
        : unwrap(api.POST("/v1/warehouses", { body: { ...body, isDefault: f.isDefault } }));
    },
    onSuccess: (w) => {
      toast.success(id ? t("saved", { name: w.name }) : t("added", { name: w.name }));
      void queryClient.invalidateQueries({ queryKey: ["stock", "warehouses"] });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.errors.length > 0) {
        setErrors(Object.fromEntries(e.errors.map((x) => [x.path.replace(/^address\./, ""), x.message])));
      } else setErrors({ root: e instanceof ApiError && e.status === 412 ? t("stale") : errorMessage(e) });
    },
  });
  const field = (
    key: keyof WarehouseForm,
    label: string,
    opts: { hint?: string; inputMode?: "tel" | "numeric" } = {},
  ) => (
    <Field id={`wh-${key}`} label={label} hint={opts.hint} error={errors[key]}>
      <Input
        value={String(f[key])}
        inputMode={opts.inputMode}
        onChange={(e) => set({ [key]: e.target.value } as Partial<WarehouseForm>)}
        {...fieldProps(`wh-${key}`, errors[key], !!opts.hint)}
      />
    </Field>
  );
  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const found = Object.fromEntries(Object.entries(warehouseProblems(f)).map(([k, p]) => [k, t(`problem_${p}`)]));
        setErrors(found);
        if (Object.keys(found).length === 0) save.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
        {field("code", t("code"), { hint: t("codeHint") })}
        {field("name", t("name"))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {field("contactName", t("contactName"))}
        {field("phone", t("phone"), { inputMode: "tel" })}
      </div>
      {field("line1", t("line1"))}
      <div className="grid gap-4 sm:grid-cols-2">
        {field("district", t("district"))}
        {field("city", t("city"))}
        <Field id="wh-province" label={t("province")} hint={t("provinceHint")} error={errors.province}>
          <Select value={f.province || NONE} onValueChange={(v) => set({ province: v === NONE ? "" : v })}>
            <SelectTrigger id="wh-province" className="w-full" aria-describedby="wh-province-message">
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
        {field("postalCode", t("postalCode"), { inputMode: "numeric" })}
      </div>
      {id === null ? (
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="wh-default" className="font-normal">
            {t("makeDefaultNew")}
          </Label>
          <Switch id="wh-default" checked={f.isDefault} onCheckedChange={(isDefault) => set({ isDefault })} />
        </div>
      ) : null}
      {errors.root ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {errors.root}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" loading={save.isPending}>
          {tCommon("save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** "Gudang marketplace" (FR-WHS-01 to 03, 10): each store's marketplace warehouses and where they point. */
function ChannelWarehouses({ warehouses }: { warehouses: Warehouse[] }) {
  const t = useTranslations("warehouses");
  const { byId } = useStores();
  const stores = [...byId.values()].filter((s) => s.channel !== "manual" && s.status !== "disconnected");
  if (stores.length === 0) return null;
  return (
    <section className="mt-6 grid gap-3" aria-labelledby="channel-warehouses">
      <h2 id="channel-warehouses" className="text-lg font-semibold text-text-900">
        {t("channelTitle")}
      </h2>
      <p className="text-sm text-text-700">{t("channelBody")}</p>
      {stores.map((s) => (
        <StoreWarehouses key={s.id} storeId={s.id} name={s.name} channel={s.channel} warehouses={warehouses} />
      ))}
    </section>
  );
}

export function StoreWarehouses({
  storeId,
  name,
  channel,
  warehouses,
}: {
  storeId: string;
  name: string;
  channel: string;
  warehouses: Warehouse[];
}) {
  const t = useTranslations("warehouses");
  const queryClient = useQueryClient();
  const key = ["stores", storeId, "channel-warehouses"];
  const list = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET("/v1/stores/{id}/channel-warehouses", { params: { path: { id: storeId } } })),
  });
  const map = useMutation({
    mutationFn: ({ cw, warehouseId }: { cw: ChannelWarehouse; warehouseId: string | null }) =>
      unwrap(
        api.PUT("/v1/stores/{id}/channel-warehouses/{channelWarehouseId}", {
          params: { path: { id: storeId, channelWarehouseId: cw.id } },
          body: { warehouseId },
        }),
      ),
    onSuccess: () => {
      toast.success(t("mapped"));
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const sync = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/stores/{id}/warehouses/sync", { params: { path: { id: storeId } } })),
    onSuccess: () => {
      toast.success(t("syncStarted"));
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: key }), 4_000);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const items = (list.data?.items ?? []).filter((cw) => cw.active);
  const unmapped = items.filter((cw) => cw.mappingStatus === "unmapped");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChannelIcon channel={channel} decorative />
          {name}
        </CardTitle>
        <CardAction>
          <Button size="sm" variant="ghost" loading={sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw aria-hidden />
            {t("sync")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        {unmapped.length > 0 ? (
          <p role="status" className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t("unmappedBanner", { count: unmapped.length })}
          </p>
        ) : null}
        {list.isPending ? (
          <Skeleton className="h-20" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon={WarehouseIcon} title={t("noChannelWarehouses")} body={t("noChannelWarehousesBody")} />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-surface-2">
                <TableRow>
                  <TableHead>{t("colChannelWarehouse")}</TableHead>
                  <TableHead>{t("colKind")}</TableHead>
                  <TableHead className="min-w-56">{t("colMappedTo")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((cw) => (
                  <TableRow key={cw.id}>
                    <TableCell className="font-medium text-text-900">{cw.name}</TableCell>
                    <TableCell className="text-text-700">{t(`kind_${cw.kind}`)}</TableCell>
                    <TableCell>
                      {cw.kind === "fulfillment" ? (
                        <span className="text-[13px] text-text-500">{t("notNeeded")}</span>
                      ) : (
                        <Select
                          value={cw.warehouseId ?? NONE}
                          onValueChange={(v) => map.mutate({ cw, warehouseId: v === NONE ? null : v })}
                        >
                          <SelectTrigger className="w-full" aria-label={t("mapTo", { name: cw.name })}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>{t("unmapped")}</SelectItem>
                            {warehouses.map((w) => (
                              <SelectItem key={w.id} value={w.id}>
                                {w.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={MAPPING_TONE[cw.mappingStatus]}>{t(`mapping_${cw.mappingStatus}`)}</StatusPill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
