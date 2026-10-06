"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner } from "@/components/common/form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { variantTitle } from "./adjust-dialog";
import {
  type LocationDraft,
  locationDrafts,
  locationPatch,
  locationProblems,
  type StockRow,
  type Warehouse,
} from "./stock-meta";

type RowErrors = { minStock?: string; binLocation?: string };
type Change = { warehouseId: string; body: NonNullable<ReturnType<typeof locationPatch>> };

/** A warehouse the api refused; the ones before it are saved. */
class SaveFailed extends Error {
  constructor(
    readonly warehouseId: string,
    readonly reason: unknown,
  ) {
    super(errorMessage(reason));
  }
}

/**
 * "Atur minimum & rak" (L19, FR-STK-07, 12): the minimum that marks a SKU as running low and the shelf it
 * sits on, per warehouse. Only what changed is sent, one warehouse at a time.
 */
export function LocationDialog({
  row,
  warehouses,
  onClose,
}: {
  row: StockRow | null;
  warehouses: Warehouse[];
  onClose: () => void;
}) {
  const t = useTranslations("stock");
  return (
    <Dialog open={row !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("locationTitle")}</DialogTitle>
          <DialogDescription>{t("locationBody")}</DialogDescription>
        </DialogHeader>
        {row ? <LocationForm row={row} warehouses={warehouses} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function LocationForm({ row, warehouses, onClose }: { row: StockRow; warehouses: Warehouse[]; onClose: () => void }) {
  const t = useTranslations("stock");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const [initial] = useState(() => locationDrafts(row, warehouses));
  const [drafts, setDrafts] = useState(initial);
  const [errors, setErrors] = useState<Record<string, RowErrors>>({});
  const [banner, setBanner] = useState<string | undefined>();
  const names = new Map(warehouses.map((w) => [w.id, w.name]));

  const save = useMutation({
    mutationFn: async (changes: Change[]) => {
      for (const c of changes) {
        try {
          await unwrap(
            api.PUT("/v1/inventory/{variantId}/warehouses/{warehouseId}", {
              params: { path: { variantId: row.id, warehouseId: c.warehouseId } },
              body: c.body,
            }),
          );
        } catch (error) {
          throw new SaveFailed(c.warehouseId, error);
        }
      }
    },
    onSuccess: () => {
      toast.success(t("locationSaved", { sku: row.sku }));
      onClose();
    },
    onError: (error) => {
      if (!(error instanceof SaveFailed)) return setBanner(errorMessage(error));
      const reason = error.reason;
      const placed: RowErrors = {};
      if (reason instanceof ApiError) {
        for (const issue of reason.errors) {
          if (issue.path === "minStock" || issue.path === "binLocation") placed[issue.path] = issue.message;
        }
      }
      if (Object.keys(placed).length > 0) setErrors({ [error.warehouseId]: placed });
      else setBanner(t("locationFailed", { warehouse: names.get(error.warehouseId) ?? "", reason: error.message }));
    },
    // the warehouses saved before a refusal count too
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["stock"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const update = (warehouseId: string, patch: Partial<LocationDraft>) => {
    setDrafts((all) => all.map((d) => (d.warehouseId === warehouseId ? { ...d, ...patch } : d)));
    setErrors((all) => ({ ...all, [warehouseId]: {} }));
  };

  const submit = () => {
    setBanner(undefined);
    const found: Record<string, RowErrors> = {};
    for (const d of drafts) {
      const p = locationProblems(d);
      if (p.minStock || p.binLocation) {
        found[d.warehouseId] = {
          ...(p.minStock ? { minStock: t(p.minStock === "tooLarge" ? "tooLarge" : "minWholeNumber") } : {}),
          ...(p.binLocation ? { binLocation: t("binTooLong") } : {}),
        };
      }
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const changes = drafts.flatMap((d, i) => {
      const body = initial[i] ? locationPatch(initial[i], d) : null;
      return body ? [{ warehouseId: d.warehouseId, body }] : [];
    });
    if (changes.length === 0) return setBanner(t("locationUnchanged"));
    save.mutate(changes);
  };

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
      <div className="grid min-w-0 gap-0.5 rounded-lg border bg-surface-2 px-3 py-2">
        <span className="font-mono text-sm text-text-900">{row.sku}</span>
        <span className="truncate text-[13px] text-text-500">{variantTitle(row)}</span>
      </div>
      {drafts.length === 0 ? <p className="text-sm text-text-500">{t("locationNoWarehouse")}</p> : null}
      {drafts.map((d) => {
        const e = errors[d.warehouseId] ?? {};
        const min = `location-min-${d.warehouseId}`;
        const bin = `location-bin-${d.warehouseId}`;
        return (
          <fieldset key={d.warehouseId} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
            <legend className="px-1 text-sm font-medium text-text-900">{names.get(d.warehouseId)}</legend>
            <Field id={min} label={t("minStock")} error={e.minStock} hint={t("minStockHint")}>
              <Input
                inputMode="numeric"
                className="tabular"
                value={d.minStock}
                onChange={(ev) => update(d.warehouseId, { minStock: ev.target.value })}
                {...fieldProps(min, e.minStock, true)}
              />
            </Field>
            <Field id={bin} label={t("binLocation")} error={e.binLocation} hint={t("binLocationHint")}>
              <Input
                value={d.binLocation}
                maxLength={50}
                onChange={(ev) => update(d.warehouseId, { binLocation: ev.target.value })}
                {...fieldProps(bin, e.binLocation, true)}
              />
            </Field>
          </fieldset>
        );
      })}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" loading={save.isPending} disabled={drafts.length === 0}>
          {tCommon("save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
