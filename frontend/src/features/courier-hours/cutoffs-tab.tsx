"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, Truck } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner } from "@/components/common/form";
import { EmptyState, ErrorState } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { useCan } from "@/lib/session";
import {
  type Cutoff,
  type CutoffDraft,
  type CutoffProblem,
  clock,
  cutoffProblems,
  DAY_ORDER,
  DAY_SHORT,
  daysLabel,
} from "./courier-hours-meta";

export const cutoffsQueryKey = ["courier-cutoffs"] as const;

function useWarehouses() {
  return useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 5 * 60_000,
  });
}

/** Cut-offs per warehouse: the courier, the last pickup, the days it comes, and whether it counts. */
export function CutoffsTab() {
  const t = useTranslations("courierHours");
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Cutoff | "new" | null>(null);
  const [removing, setRemoving] = useState<Cutoff | null>(null);
  const cutoffs = useQuery({ queryKey: cutoffsQueryKey, queryFn: () => unwrap(api.GET("/v1/courier-cutoffs")) });
  const warehouses = useWarehouses();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: cutoffsQueryKey });

  const toggle = useMutation({
    mutationFn: (c: Cutoff) =>
      unwrap(
        api.PATCH("/v1/courier-cutoffs/{id}", {
          params: { path: { id: c.id } },
          body: { active: !c.active },
          headers: { "If-Match": `"${c.rowVersion}"` },
        }),
      ),
    onSuccess: (c) => {
      toast.success(t("cutoffSaved", { courier: c.courier }));
      refresh();
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (c: Cutoff) => unwrap(api.DELETE("/v1/courier-cutoffs/{id}", { params: { path: { id: c.id } } })),
    onSuccess: (_, c) => {
      setRemoving(null);
      toast.success(t("cutoffRemoved", { courier: c.courier }));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (cutoffs.isPending || warehouses.isPending) return <Skeleton className="h-48" />;
  if (cutoffs.isError || warehouses.isError) {
    const error = cutoffs.error ?? warehouses.error;
    return (
      <Card>
        <ErrorState error={error} onRetry={() => (cutoffs.isError ? cutoffs.refetch() : warehouses.refetch())} />
      </Card>
    );
  }
  const groups = warehouses.data.items
    .map((w) => ({ warehouse: w, items: cutoffs.data.items.filter((c) => c.warehouseId === w.id) }))
    .filter((g) => g.items.length > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("tab_cutoff")}</h2>
        </CardTitle>
        <CardDescription>{t("cutoffBody")}</CardDescription>
        <CardAction>
          <Button onClick={() => setEditing("new")}>
            <Plus aria-hidden />
            {t("addCutoff")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5">
        {groups.length === 0 ? (
          <EmptyState icon={Truck} title={t("noCutoffsTitle")} body={t("noCutoffs")} />
        ) : (
          groups.map(({ warehouse, items }) => (
            <section key={warehouse.id} className="grid gap-2">
              <h3 className="text-sm font-semibold text-text-700">{warehouse.name}</h3>
              <ul
                aria-label={t("cutoffListLabel", { warehouse: warehouse.name })}
                className="divide-y rounded-lg border"
              >
                {items.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
                    <div className="grid min-w-40 flex-1 gap-0.5">
                      <span className="font-medium text-text-900">{c.courier}</span>
                      <span className="text-[13px] text-text-500">
                        {t("cutoffAt", { time: clock(c.cutoffTime), days: daysLabel(c.days, t("everyDay")) })}
                      </span>
                    </div>
                    <span className="flex items-center gap-2 text-sm text-text-700">
                      <Switch
                        checked={c.active}
                        onCheckedChange={() => toggle.mutate(c)}
                        aria-label={t("activeNamed", { courier: c.courier })}
                      />
                      {c.active ? t("active") : t("inactive")}
                    </span>
                    <span className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("editNamed", { name: c.courier })}
                        onClick={() => setEditing(c)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("removeNamed", { name: c.courier })}
                        onClick={() => setRemoving(c)}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </CardContent>
      <CutoffDialog
        cutoff={editing}
        warehouses={warehouses.data.items}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />
      <Dialog open={removing !== null} onOpenChange={(v) => !v && setRemoving(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("removeCutoffTitle", { courier: removing?.courier ?? "" })}</DialogTitle>
            <DialogDescription>{t("removeCutoffBody", { courier: removing?.courier ?? "" })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() => removing && remove.mutate(removing)}
            >
              {t("remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function CutoffDialog({
  cutoff,
  warehouses,
  onClose,
  onSaved,
}: {
  cutoff: Cutoff | "new" | null;
  warehouses: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("courierHours");
  return (
    <Dialog open={cutoff !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {cutoff && cutoff !== "new" ? t("cutoffTitleEdit", { courier: cutoff.courier }) : t("cutoffTitleAdd")}
          </DialogTitle>
          <DialogDescription>{t("cutoffDialogBody")}</DialogDescription>
        </DialogHeader>
        {cutoff ? (
          <CutoffForm
            key={cutoff === "new" ? "new" : cutoff.id}
            cutoff={cutoff === "new" ? null : cutoff}
            warehouses={warehouses}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CutoffForm({
  cutoff,
  warehouses,
  onClose,
  onSaved,
}: {
  cutoff: Cutoff | null;
  warehouses: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("courierHours");
  const can = useCan();
  const [draft, setDraft] = useState<CutoffDraft>({
    warehouseId: cutoff?.warehouseId ?? (warehouses.length === 1 ? warehouses[0]!.id : ""),
    courier: cutoff?.courier ?? "",
    cutoffTime: cutoff ? cutoff.cutoffTime : "15:00",
    days: cutoff?.days ?? [1, 2, 3, 4, 5, 6],
  });
  const [problems, setProblems] = useState<Partial<Record<keyof CutoffDraft, CutoffProblem>>>({});
  const [server, setServer] = useState<{ field?: Partial<Record<string, string>>; banner?: string }>({});
  // the couriers the business's orders actually go with, as the marketplaces name them
  const couriers = useQuery({
    queryKey: ["order-couriers", draft.warehouseId],
    queryFn: () =>
      unwrap(api.GET("/v1/orders/couriers", { params: { query: { warehouseId: draft.warehouseId || undefined } } })),
    enabled: can("order:read"),
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationFn: () =>
      cutoff
        ? unwrap(
            api.PATCH("/v1/courier-cutoffs/{id}", {
              params: { path: { id: cutoff.id } },
              body: { courier: draft.courier.trim(), cutoffTime: draft.cutoffTime, days: draft.days },
              headers: { "If-Match": `"${cutoff.rowVersion}"` },
            }),
          )
        : unwrap(
            api.POST("/v1/courier-cutoffs", {
              body: { ...draft, courier: draft.courier.trim() },
            }),
          ),
    onSuccess: (c) => {
      toast.success(t("cutoffSaved", { courier: c.courier }));
      onSaved();
      onClose();
    },
    onError: (e) => {
      const fields = e instanceof ApiError ? Object.fromEntries(e.errors.map((i) => [i.path, i.message])) : {};
      setServer(Object.keys(fields).length > 0 ? { field: fields } : { banner: errorMessage(e) });
    },
  });
  const set = (patch: Partial<CutoffDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setProblems({});
    setServer({});
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found = cutoffProblems(draft);
    setProblems(found);
    if (Object.keys(found).length === 0) save.mutate();
  };
  const error = (k: keyof CutoffDraft) =>
    problems[k] ? t(`problem_${problems[k]}`) : (server.field?.[k] ?? undefined);

  return (
    <form className="grid gap-4" noValidate onSubmit={submit}>
      <FormBanner message={server.banner} />
      {cutoff ? null : (
        <Field id="cutoff-warehouse" label={t("warehouse")} error={error("warehouseId")}>
          <Select value={draft.warehouseId} onValueChange={(v) => set({ warehouseId: v })}>
            <SelectTrigger
              id="cutoff-warehouse"
              aria-label={t("warehouse")}
              aria-invalid={error("warehouseId") ? true : undefined}
            >
              <SelectValue placeholder={t("chooseWarehouse")} />
            </SelectTrigger>
            <SelectContent>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      <Field id="cutoff-courier" label={t("courier")} hint={t("courierHint")} error={error("courier")}>
        <Input
          list="cutoff-couriers"
          autoComplete="off"
          value={draft.courier}
          onChange={(e) => set({ courier: e.target.value })}
          {...fieldProps("cutoff-courier", error("courier"), true)}
        />
      </Field>
      <datalist id="cutoff-couriers">
        {(couriers.data?.items ?? []).map((c) => (
          <option key={c.courier} value={c.courier} />
        ))}
      </datalist>
      <Field id="cutoff-time" label={t("cutoffTime")} hint={t("cutoffTimeHint")} error={error("cutoffTime")}>
        <Input
          type="time"
          className="w-36"
          value={draft.cutoffTime}
          onChange={(e) => set({ cutoffTime: e.target.value })}
          {...fieldProps("cutoff-time", error("cutoffTime"), true)}
        />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-text-700">{t("days")}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {DAY_ORDER.map((d) => (
            <div key={d} className="flex items-center gap-2">
              <Checkbox
                id={`cutoff-day-${d}`}
                checked={draft.days.includes(d)}
                onCheckedChange={(v) =>
                  set({ days: v === true ? [...draft.days, d] : draft.days.filter((x) => x !== d) })
                }
              />
              <Label htmlFor={`cutoff-day-${d}`} className="font-normal">
                {DAY_SHORT[d]}
              </Label>
            </div>
          ))}
        </div>
        {error("days") ? (
          <p role="alert" className="text-sm text-danger">
            {error("days")}
          </p>
        ) : null}
      </fieldset>
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
