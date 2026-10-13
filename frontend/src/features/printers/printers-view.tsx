"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Printer, Unplug } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Field, fieldProps } from "@/components/common/field";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Segmented } from "@/components/common/segmented";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { usePrintAgents } from "@/features/shipping/print-target";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatRelative } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import { type Agent, LABEL_OPTIONS, type LabelTemplate } from "./printer-meta";

const NONE = "none";

/**
 * L42 Printer dan Label (DOKUMEN-UI-UX 14.8, backend 8.22 and 8.24): print agents on the packing PCs (paired
 * with a code shown once, their printers, a test page, revoking), and what the custom strip under marketplace
 * labels shows, with a live preview.
 */
export function PrintersView() {
  const t = useTranslations("printers");
  const can = useCan();
  const [pairing, setPairing] = useState(false);
  if (!can("shipment:print") && !can("settings:warehouse")) {
    return <PageHeader title={t("title")} description={t("noAccess")} />;
  }
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          can("settings:warehouse") ? (
            <Button onClick={() => setPairing(true)}>
              <Plus aria-hidden />
              {t("pair")}
            </Button>
          ) : null
        }
      />
      <div className="grid gap-6">
        {can("shipment:print") ? <Agents onPair={() => setPairing(true)} /> : null}
        {can("shipment:print") ? <LabelTemplateCard /> : null}
      </div>
      {pairing ? <PairDialog onClose={() => setPairing(false)} /> : null}
    </>
  );
}

function useWarehouseNames() {
  const warehouses = useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 5 * 60_000,
  });
  return {
    list: warehouses.data?.items ?? [],
    name: (id: string | null) => warehouses.data?.items.find((w) => w.id === id)?.name ?? null,
  };
}

function Agents({ onPair }: { onPair: () => void }) {
  const t = useTranslations("printers");
  const agents = usePrintAgents();
  const can = useCan();
  if (agents.isPending) return <Skeleton className="h-40" />;
  if (agents.isError) {
    return (
      <Card>
        <ErrorState error={agents.error} onRetry={() => agents.refetch()} />
      </Card>
    );
  }
  return (
    <section className="grid gap-3" aria-labelledby="agents-title">
      <h2 id="agents-title" className="text-lg font-semibold text-text-900">
        {t("agents")}
      </h2>
      {agents.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={Printer}
            title={t("noAgents")}
            body={t("noAgentsBody")}
            action={can("settings:warehouse") ? <Button onClick={onPair}>{t("pair")}</Button> : null}
          />
        </Card>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {agents.data.items.map((a) => (
            <li key={a.id}>
              <AgentCard agent={a} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentCard({ agent: a }: { agent: Agent }) {
  const t = useTranslations("printers");
  const tz = useTimeZone();
  const can = useCan();
  const manage = can("settings:warehouse");
  const queryClient = useQueryClient();
  const warehouses = useWarehouseNames();
  const [name, setName] = useState(a.name);
  const [revoking, setRevoking] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["print-agents"] });
  // automatic rules printing to this agent would be refused after a revoke (backend doc 8.37)
  const rules = useQuery({
    queryKey: ["order-rules"],
    queryFn: () => unwrap(api.GET("/v1/order-rules")),
    enabled: revoking && can("order:accept"),
  });
  const printingRules = (rules.data?.items ?? []).filter((r) => r.actions.print?.deviceId === a.id).length;
  const update = useMutation({
    mutationFn: (body: {
      name?: string;
      labelPrinter?: string | null;
      documentPrinter?: string | null;
      warehouseId?: string | null;
    }) => unwrap(api.PATCH("/v1/print-agents/{id}", { params: { path: { id: a.id } }, body })),
    onSuccess: () => {
      toast.success(t("saved"));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/print-agents/{id}/test-print", {
          params: { path: { id: a.id } },
          body: { printer: a.labelPrinter },
        }),
      ),
    onSuccess: (job) => toast.success(t("testSent", { printer: job.printer ?? a.labelPrinter ?? t("defaultPrinter") })),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/print-agents/{id}", { params: { path: { id: a.id } } })),
    onSuccess: () => {
      toast.success(t("revoked", { name: a.name }));
      setRevoking(false);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const printerSelect = (id: string, label: string, value: string | null, key: "labelPrinter" | "documentPrinter") => (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? NONE}
        disabled={!manage || a.printers.length === 0}
        onValueChange={(v) => update.mutate({ [key]: v === NONE ? null : v })}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t("defaultPrinter")}</SelectItem>
          {a.printers.map((p) => (
            <SelectItem key={p.name} value={p.name}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Printer className="size-5 text-primary" aria-hidden />
          {a.name}
          <StatusPill tone={a.connected ? "success" : "neutral"} icon={a.connected ? undefined : Unplug}>
            {a.connected ? t("connected") : t("disconnected")}
          </StatusPill>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-[13px] text-text-500">
          {[
            warehouses.name(a.warehouseId) ?? t("anyWarehouse"),
            a.lastSeenAt ? t("lastSeen", { at: formatRelative(a.lastSeenAt, tz) }) : t("neverSeen"),
            a.appVersion ? t("version", { version: a.appVersion }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {a.printers.length === 0 ? <p className="text-sm text-text-700">{t("noPrinters")}</p> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {printerSelect(`label-printer-${a.id}`, t("labelPrinter"), a.labelPrinter, "labelPrinter")}
          {printerSelect(`doc-printer-${a.id}`, t("documentPrinter"), a.documentPrinter, "documentPrinter")}
        </div>
        {manage ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== a.name) update.mutate({ name: name.trim() });
            }}
          >
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor={`agent-name-${a.id}`}>{t("agentName")}</Label>
              <Input id={`agent-name-${a.id}`} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Button type="submit" variant="secondary" disabled={!name.trim() || name.trim() === a.name}>
              {t("rename")}
            </Button>
          </form>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!a.connected}
            loading={test.isPending}
            onClick={() => test.mutate()}
          >
            {t("testPrint")}
          </Button>
          {manage ? (
            <Button size="sm" variant="ghost" onClick={() => setRevoking(true)}>
              {t("revoke")}
            </Button>
          ) : null}
        </div>
      </CardContent>
      <Dialog open={revoking} onOpenChange={(v) => !v && setRevoking(false)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("revokeTitle", { name: a.name })}</DialogTitle>
            <DialogDescription>
              {t("revokeBody")}
              {printingRules > 0 ? ` ${t("revokeRules", { count: printingRules })}` : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRevoking(false)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" loading={revoke.isPending} onClick={() => revoke.mutate()}>
              {t("revoke")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Pairing an agent: its name and warehouse, then the code it signs in with, shown here once. */
function PairDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("printers");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const warehouses = useWarehouseNames();
  const [name, setName] = useState("");
  const [warehouseId, setWarehouseId] = useState(NONE);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pair = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/print-agents", {
          body: { name: name.trim(), warehouseId: warehouseId === NONE ? null : warehouseId },
        }),
      ),
    onSuccess: (r) => {
      setToken(r.token);
      void queryClient.invalidateQueries({ queryKey: ["print-agents"] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token ?? "");
      toast.success(tCommon("copied"));
    } catch {
      toast.error(tCommon("copyFailed"));
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("pairTitle")}</DialogTitle>
          <DialogDescription>{token ? t("tokenBody") : t("pairBody")}</DialogDescription>
        </DialogHeader>
        {token ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-3 py-2.5 font-mono text-sm text-text-900">
                {token}
              </code>
              <Button variant="secondary" onClick={copy}>
                <Copy aria-hidden />
                {tCommon("copy")}
              </Button>
            </div>
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-text-900">{t("tokenOnce")}</p>
            <DialogFooter>
              <Button onClick={onClose}>{t("done")}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) pair.mutate();
            }}
          >
            <Field id="pair-name" label={t("agentName")} hint={t("agentNameHint")}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                {...fieldProps("pair-name", undefined, true)}
              />
            </Field>
            <Field id="pair-warehouse" label={t("warehouse")}>
              <Select value={warehouseId} onValueChange={setWarehouseId}>
                <SelectTrigger id="pair-warehouse" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("anyWarehouse")}</SelectItem>
                  {warehouses.list.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {error ? (
              <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onClose}>
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={!name.trim()} loading={pair.isPending}>
                {t("makeCode")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** FR-SHP-16: what the strip under marketplace labels shows; the marketplace label itself is never drawn over. */
function LabelTemplateCard() {
  const t = useTranslations("printers");
  const can = useCan();
  const queryClient = useQueryClient();
  const [format, setFormat] = useState<"thermal" | "a4">("thermal");
  const [version, setVersion] = useState(0);
  const template = useQuery({ queryKey: ["label-template"], queryFn: () => unwrap(api.GET("/v1/label-template")) });
  const save = useMutation({
    mutationFn: (patch: Partial<LabelTemplate>) => unwrap(api.PUT("/v1/label-template", { body: patch })),
    onSuccess: (saved) => {
      queryClient.setQueryData(["label-template"], saved);
      setVersion((v) => v + 1);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const edit = can("settings:warehouse");
  return (
    <section className="grid gap-3" aria-labelledby="template-title">
      <h2 id="template-title" className="text-lg font-semibold text-text-900">
        {t("template")}
      </h2>
      <Card>
        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
          <div className="grid content-start gap-3">
            <p className="text-sm text-text-700">{t("templateBody")}</p>
            {template.isPending ? (
              <Skeleton className="h-40" />
            ) : template.isError ? (
              <ErrorState error={template.error} onRetry={() => template.refetch()} />
            ) : (
              <ul className="grid gap-3">
                {LABEL_OPTIONS.map((o) => (
                  <li key={o} className="flex items-center justify-between gap-3">
                    <Label htmlFor={`tpl-${o}`} className="grid gap-0.5 font-normal">
                      <span className="text-sm text-text-900">{t(`opt_${o}`)}</span>
                      <span className="text-[13px] text-text-500">{t(`optHint_${o}`)}</span>
                    </Label>
                    <Switch
                      id={`tpl-${o}`}
                      checked={template.data[o]}
                      disabled={!edit || save.isPending}
                      onCheckedChange={(on) => save.mutate({ [o]: on })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="grid content-start gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-text-700">{t("preview")}</span>
              <Segmented
                label={t("previewFormat")}
                value={format}
                onChange={setFormat}
                options={[
                  { value: "thermal", label: t("thermal") },
                  { value: "a4", label: "A4" },
                ]}
              />
            </div>
            <iframe
              key={`${format}-${version}`}
              title={t("previewTitle")}
              src={`/v1/label-template/preview?format=${format}&v=${version}`}
              className="h-[420px] w-full rounded-lg border bg-surface-2"
            />
            <a
              href={`/v1/label-template/preview?format=${format}`}
              target="_blank"
              rel="noopener"
              className="text-sm font-medium text-primary hover:underline"
            >
              {t("openPreview")}
            </a>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
