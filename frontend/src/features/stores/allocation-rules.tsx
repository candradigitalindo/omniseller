"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FormBanner } from "@/components/common/form";
import { ErrorState, StatusPill } from "@/components/common/page";
import { Segmented } from "@/components/common/segmented";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { api, unwrap, unwrapWithEtag } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { formatNumber } from "@/lib/format";
import {
  allocatePreview,
  type Rule,
  type RuleDraft,
  type RuleMode,
  ruleBody,
  ruleDraftOf,
  rulePatch,
  ruleProblems,
  ruleScope,
  type StoreDetail,
} from "./store-admin-meta";

const ALL = "all";
const SAMPLE = 20;
type ChannelWarehouse = { id: string; name: string; kind: string; active: boolean };

/**
 * "Aturan pembagian stok" (FR-STK-04, FR-WHS-05): how much of the ready-to-sell stock this store shows, for
 * the whole store, one marketplace warehouse, one variant, or both. The most specific rule wins.
 */
export function AllocationRules({ store: s }: { store: StoreDetail }) {
  const t = useTranslations("storeRules");
  const queryClient = useQueryClient();
  const key = ["stock-rules", s.id];
  const rules = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET("/v1/stock-allocation-rules", { params: { query: { storeId: s.id } } })),
  });
  const warehouses = useQuery({
    queryKey: ["stores", s.id, "channel-warehouses"],
    queryFn: () => unwrap(api.GET("/v1/stores/{id}/channel-warehouses", { params: { path: { id: s.id } } })),
  });
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const sellerWarehouses: ChannelWarehouse[] = (warehouses.data?.items ?? []).filter(
    (w) => w.active && w.kind === "seller",
  );
  const warehouseName = (id: string | null) => sellerWarehouses.find((w) => w.id === id)?.name ?? t("unknownWarehouse");

  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/v1/stock-allocation-rules/{id}", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success(t("deleted"));
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const scopeText = (r: Rule) => {
    const variant = r.variant ? `${r.variant.sku} · ${r.variant.productName}` : t("unknownVariant");
    switch (ruleScope(r)) {
      case "store":
        return t("scopeStore");
      case "warehouse":
        return warehouseName(r.channelWarehouseId);
      case "variant":
        return variant;
      case "both":
        return `${variant} · ${warehouseName(r.channelWarehouseId)}`;
    }
  };
  const shareText = (r: Pick<Rule, "mode" | "value">) =>
    r.mode === "all"
      ? t("shareAll")
      : r.mode === "percent"
        ? t("sharePercent", { value: r.value })
        : t("shareFixed", { value: r.value });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("body")}</CardDescription>
        <CardAction>
          <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
            <Plus aria-hidden />
            {t("add")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {rules.isPending ? (
          <Skeleton className="h-24" />
        ) : rules.isError ? (
          <ErrorState error={rules.error} onRetry={() => rules.refetch()} />
        ) : rules.data.items.length === 0 ? (
          <p className="text-sm text-text-500">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-surface-2">
                <TableRow>
                  <TableHead>{t("colScope")}</TableHead>
                  <TableHead>{t("colShare")}</TableHead>
                  <TableHead className="text-right">{t("colBuffer")}</TableHead>
                  <TableHead className="text-right">{t("colPriority")}</TableHead>
                  <TableHead>{t("colState")}</TableHead>
                  <TableHead className="w-px" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.data.items.map((r) =>
                  deleting === r.id ? (
                    <TableRow key={r.id} className="bg-danger-soft">
                      <TableCell colSpan={5} className="text-sm text-text-900">
                        {t("deleteAsk", { scope: scopeText(r) })}
                      </TableCell>
                      <TableCell>
                        <span className="flex gap-1.5">
                          <Button
                            size="sm"
                            variant="destructive"
                            loading={remove.isPending}
                            onClick={() => remove.mutate(r.id)}
                          >
                            {t("deleteConfirm")}
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setDeleting(null)}>
                            {t("keep")}
                          </Button>
                        </span>
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-72 truncate text-text-900">{scopeText(r)}</TableCell>
                      <TableCell>{shareText(r)}</TableCell>
                      <TableCell className="tabular text-right">{formatNumber(r.buffer)}</TableCell>
                      <TableCell className="tabular text-right">{formatNumber(r.priority)}</TableCell>
                      <TableCell>
                        <StatusPill tone={r.active ? "success" : "neutral"}>
                          {t(r.active ? "active" : "inactive")}
                        </StatusPill>
                      </TableCell>
                      <TableCell>
                        <span className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t("editNamed", { scope: scopeText(r) })}
                            onClick={() => setEditing(r)}
                          >
                            {t("edit")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t("deleteNamed", { scope: scopeText(r) })}
                            onClick={() => setDeleting(r.id)}
                          >
                            {t("delete")}
                          </Button>
                        </span>
                      </TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      <RuleDialog
        storeId={s.id}
        rule={editing === "new" ? null : editing}
        open={editing !== null}
        warehouses={sellerWarehouses}
        shareText={shareText}
        onClose={() => setEditing(null)}
      />
    </Card>
  );
}

function RuleDialog({
  storeId,
  rule,
  open,
  warehouses,
  shareText,
  onClose,
}: {
  storeId: string;
  rule: Rule | null;
  open: boolean;
  warehouses: ChannelWarehouse[];
  shareText: (r: Pick<Rule, "mode" | "value">) => string;
  onClose: () => void;
}) {
  const t = useTranslations("storeRules");
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t(rule ? "editTitle" : "addTitle")}</DialogTitle>
          <DialogDescription>{t("dialogBody")}</DialogDescription>
        </DialogHeader>
        {open ? (
          <RuleForm
            key={rule?.id ?? "new"}
            storeId={storeId}
            rule={rule}
            warehouses={warehouses}
            shareText={shareText}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RuleForm({
  storeId,
  rule,
  warehouses,
  shareText,
  onClose,
}: {
  storeId: string;
  rule: Rule | null;
  warehouses: ChannelWarehouse[];
  shareText: (r: Pick<Rule, "mode" | "value">) => string;
  onClose: () => void;
}) {
  const t = useTranslations("storeRules");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RuleDraft>(() => ruleDraftOf(rule));
  const [variantLabel, setVariantLabel] = useState(
    rule?.variant ? `${rule.variant.sku} · ${rule.variant.productName}` : "",
  );
  const [errors, setErrors] = useState<Partial<Record<"value" | "buffer" | "priority", string>>>({});
  const [banner, setBanner] = useState<string | undefined>();
  // the version the rule was read at, so a save never overwrites someone else's change
  const current = useQuery({
    queryKey: ["stock-rules", "one", rule?.id],
    queryFn: () =>
      unwrapWithEtag(api.GET("/v1/stock-allocation-rules/{id}", { params: { path: { id: rule?.id ?? "" } } })),
    enabled: rule !== null,
    gcTime: 0,
  });
  const update = (patch: Partial<RuleDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors({});
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!rule) return unwrap(api.POST("/v1/stock-allocation-rules", { body: ruleBody(storeId, draft) }));
      const patch = rulePatch(rule, draft);
      if (!patch) return null;
      const etag = current.data?.etag ?? null;
      return unwrap(
        api.PATCH("/v1/stock-allocation-rules/{id}", {
          params: { path: { id: rule.id } },
          body: patch,
          ...(etag ? { headers: { "If-Match": etag } } : {}),
        }),
      );
    },
    onSuccess: (saved) => {
      if (saved) toast.success(t(rule ? "saved" : "created"));
      void queryClient.invalidateQueries({ queryKey: ["stock-rules", storeId] });
      onClose();
    },
    onError: (error) => {
      const placed: Partial<Record<"value" | "buffer" | "priority", string>> = {};
      if (error instanceof ApiError) {
        for (const issue of error.errors) {
          if (issue.path === "value" || issue.path === "buffer" || issue.path === "priority") {
            placed[issue.path] = issue.message;
          }
        }
      }
      if (Object.keys(placed).length > 0) setErrors(placed);
      else setBanner(errorMessage(error));
    },
  });

  const submit = () => {
    setBanner(undefined);
    const found = ruleProblems(draft);
    const text: Partial<Record<"value" | "buffer" | "priority", string>> = {};
    for (const [k, v] of Object.entries(found) as ["value" | "buffer" | "priority", string][]) {
      text[k] = t(`problem_${v as "required" | "wholeNumber" | "percentMax" | "tooLarge" | "priorityRange"}`);
    }
    setErrors(text);
    if (Object.keys(text).length === 0) save.mutate();
  };

  const valid = Object.keys(ruleProblems(draft)).length === 0;
  const sample = valid
    ? allocatePreview(SAMPLE, {
        mode: draft.mode,
        value: draft.mode === "all" ? 0 : Number(draft.value.trim()),
        buffer: draft.buffer.trim() === "" ? 0 : Number(draft.buffer.trim()),
      })
    : null;
  const modes: { value: RuleMode; label: string }[] = [
    { value: "all", label: t("mode_all") },
    { value: "percent", label: t("mode_percent") },
    { value: "fixed", label: t("mode_fixed") },
  ];

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <FormBanner message={banner} />
      {rule ? (
        <p className="rounded-lg border bg-surface-2 px-3 py-2 text-sm text-text-700">{t("scopeFixed")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="rule-warehouse">{t("warehouse")}</Label>
            <Select
              value={draft.channelWarehouseId ?? ALL}
              onValueChange={(v) => update({ channelWarehouseId: v === ALL ? null : v })}
            >
              <SelectTrigger id="rule-warehouse" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("allWarehouses")}</SelectItem>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <VariantChoice
            label={variantLabel}
            onPick={(v) => {
              update({ variantId: v?.id ?? null });
              setVariantLabel(v ? `${v.sku} · ${v.title}` : "");
            }}
          />
        </div>
      )}
      <div className="grid gap-1.5">
        <span className="text-sm font-medium text-text-700">{t("share")}</span>
        <Segmented value={draft.mode} options={modes} onChange={(mode) => update({ mode })} label={t("share")} block />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {draft.mode !== "all" ? (
          <NumberField
            id="rule-value"
            label={t(draft.mode === "percent" ? "valuePercent" : "valueFixed")}
            value={draft.value}
            error={errors.value}
            onChange={(value) => update({ value })}
          />
        ) : null}
        <NumberField
          id="rule-buffer"
          label={t("buffer")}
          value={draft.buffer}
          error={errors.buffer}
          onChange={(buffer) => update({ buffer })}
        />
        <NumberField
          id="rule-priority"
          label={t("priority")}
          value={draft.priority}
          error={errors.priority}
          onChange={(priority) => update({ priority })}
        />
      </div>
      <div className="flex items-start justify-between gap-4">
        <Label htmlFor="rule-active" className="grid gap-0.5 font-normal">
          <span className="font-medium text-text-900">{t("activeLabel")}</span>
          <span className="text-[13px] text-text-500">{t("activeHint")}</span>
        </Label>
        <Switch id="rule-active" checked={draft.active} onCheckedChange={(active) => update({ active })} />
      </div>
      <p className="rounded-lg bg-primary-50 px-3 py-2 text-sm text-text-900" aria-live="polite">
        {sample === null
          ? t("previewWaiting")
          : t("preview", {
              sample: SAMPLE,
              shown: sample,
              share: shareText({ mode: draft.mode, value: draft.mode === "all" ? 0 : Number(draft.value.trim()) }),
            })}
      </p>
      <p className="text-[13px] text-text-500">{t("priorityHint")}</p>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" loading={save.isPending} disabled={rule !== null && current.isPending}>
          {tCommon("save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function NumberField({
  id,
  label,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="numeric"
        className="tabular"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-message` : undefined}
      />
      {error ? (
        <p id={`${id}-message`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** "Semua varian", or one variant found by its SKU or name. */
function VariantChoice({
  label,
  onPick,
}: {
  label: string;
  onPick: (variant: { id: string; sku: string; title: string } | null) => void;
}) {
  const t = useTranslations("storeRules");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);
  const found = useQuery({
    queryKey: ["stock", "pick-rule", term],
    queryFn: () => unwrap(api.GET("/v1/inventory", { params: { query: { q: term, limit: 6 } } })),
    enabled: term.length >= 2,
  });
  const results = term.length >= 2 && term === q.trim() ? found.data?.items : undefined;
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor="rule-variant">{t("variant")}</Label>
      {label ? (
        <span className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-sm">
          <span className="truncate text-text-900">{label}</span>
          <Button type="button" size="sm" variant="link" className="h-auto" onClick={() => onPick(null)}>
            {t("allVariantsInstead")}
          </Button>
        </span>
      ) : (
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-500"
            aria-hidden
          />
          <Input
            id="rule-variant"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("allVariants")}
            className="pl-8"
          />
        </div>
      )}
      {!label && results ? (
        <ul className="grid gap-0.5 rounded-lg border p-1" aria-label={t("variantResults")}>
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="grid w-full rounded-md px-2 py-1 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onPick({ id: r.id, sku: r.sku, title: r.productName });
                  setQ("");
                }}
              >
                <span className="font-mono text-sm text-text-900">{r.sku}</span>
                <span className="truncate text-[13px] text-text-500">{r.productName}</span>
              </button>
            </li>
          ))}
          {results.length === 0 ? <li className="px-2 py-1 text-sm text-text-500">{t("noVariant")}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
