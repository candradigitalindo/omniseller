"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner } from "@/components/common/form";
import { Segmented } from "@/components/common/segmented";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { useCan } from "@/lib/session";
import {
  type DraftProblem,
  draftOf,
  draftProblems,
  emptyDraft,
  fieldOfPath,
  ITEMS,
  KEEP_WAREHOUSE,
  type OrderRule,
  PROCESS,
  type RuleDraft,
  ruleBody,
} from "./order-rules-meta";
import { useRuleChoices } from "./use-rule-choices";

/** The editor of one rule (L55): what a new order must be, then what is done with it. */
export function RuleDialog({
  rule,
  onClose,
  onSaved,
}: {
  rule: OrderRule | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("orderRules");
  return (
    <Dialog open={rule !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{rule && rule !== "new" ? t("editTitle", { name: rule.name }) : t("addTitle")}</DialogTitle>
          <DialogDescription>{t("dialogBody")}</DialogDescription>
        </DialogHeader>
        {rule ? (
          <RuleForm
            key={rule === "new" ? "new" : rule.id}
            rule={rule === "new" ? null : rule}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RuleForm({ rule, onClose, onSaved }: { rule: OrderRule | null; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("orderRules");
  const can = useCan();
  const choices = useRuleChoices();
  const [draft, setDraft] = useState<RuleDraft>(rule ? draftOf(rule) : emptyDraft());
  const [problems, setProblems] = useState<Partial<Record<string, DraftProblem>>>({});
  const [server, setServer] = useState<{ field?: Partial<Record<string, string>>; banner?: string }>({});
  // the couriers the business's orders actually go with, as the marketplaces name them
  const couriers = useQuery({
    queryKey: ["order-couriers", null],
    queryFn: () => unwrap(api.GET("/v1/orders/couriers", { params: { query: {} } })),
    enabled: can("order:read"),
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationFn: () =>
      rule
        ? unwrap(
            api.PATCH("/v1/order-rules/{id}", {
              params: { path: { id: rule.id } },
              body: ruleBody(draft),
              headers: { "If-Match": `"${rule.rowVersion}"` },
            }),
          )
        : unwrap(api.POST("/v1/order-rules", { body: ruleBody(draft) })),
    onSuccess: (r) => {
      toast.success(t("saved", { name: r.name }));
      onSaved();
      onClose();
    },
    onError: (e) => {
      const fields =
        e instanceof ApiError ? Object.fromEntries(e.errors.map((i) => [fieldOfPath(i.path), i.message])) : {};
      setServer(Object.keys(fields).length > 0 ? { field: fields } : { banner: errorMessage(e) });
    },
  });
  const set = (patch: Partial<RuleDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setProblems({});
    setServer({});
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found = draftProblems(draft);
    setProblems(found);
    if (Object.keys(found).length === 0) save.mutate();
  };
  const error = (k: string) => (problems[k] ? t(`problem_${problems[k]}`) : (server.field?.[k] ?? undefined));
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  const arranges = can("shipment:arrange");

  return (
    <form className="grid gap-5" noValidate onSubmit={submit}>
      <Field id="rule-name" label={t("name")} hint={t("nameHint")} error={error("name")}>
        <Input
          value={draft.name}
          maxLength={60}
          onChange={(e) => set({ name: e.target.value })}
          {...fieldProps("rule-name", error("name"), true)}
        />
      </Field>

      <fieldset className="grid gap-4 rounded-lg border p-3 md:p-4">
        <legend className="px-1 text-sm font-semibold text-text-900">{t("conditionsTitle")}</legend>
        <p className="-mt-2 text-[13px] text-text-500">{t("conditionsHint")}</p>
        {choices.stores.length > 0 ? (
          <CheckList
            id="rule-stores"
            legend={t("stores")}
            hint={t("storesHint")}
            error={error("storeIds")}
            options={choices.stores.map((s) => ({
              id: s.id,
              label: s.syncMode === "read_only" ? t("storeReadOnly", { name: s.name }) : s.name,
            }))}
            value={draft.storeIds}
            onChange={(id, on) => set({ storeIds: toggle(draft.storeIds, id, on) })}
          />
        ) : null}
        <Field id="rule-couriers" label={t("couriers")} hint={t("couriersHint")} error={error("couriers")}>
          <Input
            list="rule-courier-list"
            autoComplete="off"
            value={draft.couriers}
            onChange={(e) => set({ couriers: e.target.value })}
            {...fieldProps("rule-couriers", error("couriers"), true)}
          />
        </Field>
        <datalist id="rule-courier-list">
          {(couriers.data?.items ?? []).map((c) => (
            <option key={c.courier} value={c.courier} />
          ))}
        </datalist>
        {choices.warehouses.length > 1 ? (
          <CheckList
            id="rule-warehouses"
            legend={t("warehouses")}
            hint={t("warehousesHint")}
            error={error("warehouseIds")}
            options={choices.warehouses.map((w) => ({ id: w.id, label: w.name }))}
            value={draft.warehouseIds}
            onChange={(id, on) => set({ warehouseIds: toggle(draft.warehouseIds, id, on) })}
          />
        ) : null}
        <Field id="rule-skus" label={t("skus")} hint={t("skusHint")} error={error("skus")}>
          <Textarea
            rows={2}
            value={draft.skus}
            onChange={(e) => set({ skus: e.target.value })}
            {...fieldProps("rule-skus", error("skus"), true)}
          />
        </Field>
        <div className="grid gap-1.5">
          <span className="text-sm font-medium text-text-700">{t("items")}</span>
          <Segmented
            block
            label={t("items")}
            value={draft.items}
            options={ITEMS.map((v) => ({ value: v, label: t(`items_${v}`) }))}
            onChange={(items) => set({ items })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field id="rule-min" label={t("minTotal")} error={error("minTotal")}>
            <Input
              inputMode="numeric"
              placeholder="Rp"
              value={draft.minTotal}
              onChange={(e) => set({ minTotal: e.target.value })}
              {...fieldProps("rule-min", error("minTotal"))}
            />
          </Field>
          <Field id="rule-max" label={t("maxTotal")} error={error("maxTotal")}>
            <Input
              inputMode="numeric"
              placeholder="Rp"
              value={draft.maxTotal}
              onChange={(e) => set({ maxTotal: e.target.value })}
              {...fieldProps("rule-max", error("maxTotal"))}
            />
          </Field>
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-0.5">
            <Label htmlFor="rule-hours" className="font-medium text-text-700">
              {t("withinHours")}
            </Label>
            <p id="rule-hours-hint" className="text-[13px] text-text-500">
              {t.rich("withinHoursHint", {
                link: (chunks) => (
                  <Link href="/kurir-jam" className="font-medium text-primary hover:underline">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          </div>
          <Switch
            id="rule-hours"
            aria-describedby="rule-hours-hint"
            checked={draft.withinOperatingHours}
            onCheckedChange={(withinOperatingHours) => set({ withinOperatingHours })}
          />
        </div>
      </fieldset>

      <fieldset className="grid gap-4 rounded-lg border p-3 md:p-4">
        <legend className="px-1 text-sm font-semibold text-text-900">{t("actionsTitle")}</legend>
        {choices.warehouses.length > 1 ? (
          <Field id="rule-warehouse" label={t("moveTo")} error={error("warehouseId")}>
            <Select value={draft.warehouseId} onValueChange={(warehouseId) => set({ warehouseId })}>
              <SelectTrigger
                id="rule-warehouse"
                aria-invalid={error("warehouseId") ? true : undefined}
                aria-describedby={error("warehouseId") ? "rule-warehouse-message" : undefined}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={KEEP_WAREHOUSE}>{t("keepWarehouse")}</SelectItem>
                {choices.warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        {can("order:tag") ? (
          choices.tags.length > 0 ? (
            <CheckList
              id="rule-tags"
              legend={t("tags")}
              error={error("tagIds")}
              options={choices.tags.map((tag) => ({ id: tag.id, label: tag.name }))}
              value={draft.tagIds}
              onChange={(id, on) => set({ tagIds: toggle(draft.tagIds, id, on) })}
            />
          ) : (
            <p className="text-sm text-text-500">{t("noTags")}</p>
          )
        ) : null}
        <div className="grid gap-1.5">
          <span id="rule-process-label" className="text-sm font-medium text-text-700">
            {t("process")}
          </span>
          <RadioGroup
            aria-labelledby="rule-process-label"
            aria-describedby="rule-process-hint"
            value={draft.process}
            onValueChange={(v) => set({ process: PROCESS.find((p) => p === v) ?? "none" })}
            className="grid gap-2 sm:grid-cols-2"
          >
            {PROCESS.filter((p) => arranges || (p !== "pickup" && p !== "dropoff")).map((p) => (
              <Label
                key={p}
                htmlFor={`rule-process-${p}`}
                className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary-50"
              >
                <RadioGroupItem id={`rule-process-${p}`} value={p} />
                {t(`process_${p}`)}
              </Label>
            ))}
          </RadioGroup>
          <p id="rule-process-hint" className="text-[13px] text-text-500">
            {t("processHint")}
          </p>
        </div>
        {error("actions") ? (
          <p role="alert" className="text-sm text-danger">
            {error("actions")}
          </p>
        ) : null}
      </fieldset>

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="rule-active" className="font-medium text-text-700">
          {t("activeLabel")}
        </Label>
        <Switch id="rule-active" checked={draft.active} onCheckedChange={(active) => set({ active })} />
      </div>
      {/* near the button that sends it: the dialog may be scrolled past the top */}
      <FormBanner message={server.banner} />
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button type="submit" loading={save.isPending}>
          {t("save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Choices as checkboxes under a legend; none ticked means any. Long lists scroll inside. */
function CheckList({
  id,
  legend,
  hint,
  error,
  options,
  value,
  onChange,
}: {
  id: string;
  legend: string;
  hint?: string;
  error?: string | undefined;
  options: { id: string; label: string }[];
  value: string[];
  onChange: (id: string, on: boolean) => void;
}) {
  return (
    <fieldset className="grid gap-1.5" aria-describedby={error || hint ? `${id}-message` : undefined}>
      <legend className="mb-1 text-sm font-medium text-text-700">{legend}</legend>
      <div className="grid max-h-40 gap-x-4 gap-y-2 overflow-y-auto sm:grid-cols-2">
        {options.map((o) => (
          <div key={o.id} className="flex items-center gap-2">
            <Checkbox
              id={`${id}-${o.id}`}
              checked={value.includes(o.id)}
              onCheckedChange={(v) => onChange(o.id, v === true)}
            />
            <Label htmlFor={`${id}-${o.id}`} className="font-normal">
              {o.label}
            </Label>
          </div>
        ))}
      </div>
      {error ? (
        <p id={`${id}-message`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-message`} className="text-[13px] text-text-500">
          {hint}
        </p>
      ) : null}
    </fieldset>
  );
}
