"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner, showServerErrors } from "@/components/common/form";
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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { formatNumber } from "@/lib/format";
import { ADJUST_REASONS, adjustedOnHand, type StockRow, type Warehouse } from "./stock-meta";

/**
 * "Sesuaikan stok" (L19, FR-STK-05): one variant in one warehouse, a counted quantity or a difference, and
 * a reason from the list. Opened from a row it knows the variant; from the page header it asks for one.
 */
export function AdjustStockDialog({
  open,
  row,
  warehouses,
  warehouseId,
  onClose,
}: {
  open: boolean;
  row: StockRow | null;
  warehouses: Warehouse[];
  warehouseId: string | null;
  onClose: () => void;
}) {
  const t = useTranslations("stock");
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("adjustTitle")}</DialogTitle>
          <DialogDescription>{t("adjustBody")}</DialogDescription>
        </DialogHeader>
        {open ? (
          <AdjustBody initialRow={row} warehouses={warehouses} warehouseId={warehouseId} onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AdjustBody({
  initialRow,
  warehouses,
  warehouseId,
  onClose,
}: {
  initialRow: StockRow | null;
  warehouses: Warehouse[];
  warehouseId: string | null;
  onClose: () => void;
}) {
  const [row, setRow] = useState<StockRow | null>(initialRow);
  if (!row) return <VariantPicker onPick={setRow} />;
  return (
    <AdjustForm
      row={row}
      warehouses={warehouses}
      warehouseId={warehouseId}
      onChangeVariant={initialRow ? null : () => setRow(null)}
      onClose={onClose}
    />
  );
}

function VariantPicker({ onPick }: { onPick: (row: StockRow) => void }) {
  const t = useTranslations("stock");
  const [q, setQ] = useState("");
  const query = q.trim();
  const results = useQuery({
    queryKey: ["stock", "pick", query],
    queryFn: () => unwrap(api.GET("/v1/inventory", { params: { query: { q: query, limit: 8 } } })),
    enabled: query.length >= 2,
  });
  return (
    <div className="grid gap-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-500"
          aria-hidden
        />
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("pickPlaceholder")}
          aria-label={t("pickPlaceholder")}
          className="pl-9"
        />
      </div>
      {query.length < 2 ? (
        <p className="text-sm text-text-500">{t("pickHint")}</p>
      ) : results.isPending ? (
        <p className="text-sm text-text-500">{t("searching")}</p>
      ) : results.isError || results.data.items.length === 0 ? (
        <p className="text-sm text-text-500">{t("pickNone")}</p>
      ) : (
        <ul className="grid max-h-72 gap-1 overflow-y-auto">
          {results.data.items.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onPick(r)}
                className="grid w-full gap-0.5 rounded-lg px-3 py-2 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="font-mono text-sm text-text-900">{r.sku}</span>
                <span className="truncate text-[13px] text-text-500">{variantTitle(r)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const WHOLE_NUMBER = /^-?\d+$/;

export function variantTitle(r: Pick<StockRow, "productName" | "name">): string {
  return r.name && r.name !== r.productName ? `${r.productName} · ${r.name}` : r.productName;
}

function AdjustForm({
  row,
  warehouses,
  warehouseId,
  onChangeVariant,
  onClose,
}: {
  row: StockRow;
  warehouses: Warehouse[];
  warehouseId: string | null;
  onChangeVariant: (() => void) | null;
  onClose: () => void;
}) {
  const t = useTranslations("stock");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const usable = warehouses.filter((w) => w.active);
  const onHandIn = (id: string) => row.warehouses.find((c) => c.warehouseId === id)?.onHand ?? 0;
  const schema = z
    .object({
      warehouseId: z.string().min(1, t("required")),
      mode: z.enum(["set", "delta"]),
      // typed as text: an empty number input is "", never NaN
      quantity: z
        .string()
        .trim()
        .min(1, t("quantityRequired"))
        .regex(WHOLE_NUMBER, t("wholeNumber"))
        .transform(Number)
        .pipe(z.number().min(-10_000_000, t("tooLarge")).max(10_000_000, t("tooLarge"))),
      reason: z.enum(ADJUST_REASONS),
      note: z.string().max(500, t("tooLong")),
    })
    .superRefine((v, c) => {
      if (v.mode === "set" && v.quantity < 0)
        c.addIssue({ code: "custom", path: ["quantity"], message: t("notNegative") });
      if (v.mode === "delta" && v.quantity === 0)
        c.addIssue({ code: "custom", path: ["quantity"], message: t("notZero") });
      if (v.mode === "delta" && adjustedOnHand(onHandIn(v.warehouseId), "delta", v.quantity) < 0) {
        c.addIssue({
          code: "custom",
          path: ["quantity"],
          message: t("belowZero", { onHand: onHandIn(v.warehouseId) }),
        });
      }
      if (v.reason === "other" && !v.note.trim())
        c.addIssue({ code: "custom", path: ["note"], message: t("noteRequired") });
    });
  type Input = z.input<typeof schema>;
  type Values = z.output<typeof schema>;
  const initialWarehouse =
    (warehouseId && usable.some((w) => w.id === warehouseId) ? warehouseId : null) ??
    usable.find((w) => w.isDefault)?.id ??
    usable[0]?.id ??
    "";
  const form = useForm<Input, unknown, Values>({
    resolver: zodResolver(schema),
    defaultValues: { warehouseId: initialWarehouse, mode: "set", quantity: "", reason: "correction", note: "" },
  });
  const { errors } = form.formState;
  const values = form.watch();
  const before = onHandIn(values.warehouseId);
  const typed = values.quantity.trim();
  const after = WHOLE_NUMBER.test(typed) ? adjustedOnHand(before, values.mode, Number(typed)) : null;

  const adjust = useMutation({
    mutationFn: (v: Values) =>
      unwrap(
        api.POST("/v1/inventory/adjustments", {
          body: {
            lines: [{ variantId: row.id, warehouseId: v.warehouseId, mode: v.mode, quantity: v.quantity }],
            reason: v.reason,
            note: v.note.trim() || null,
          },
        }),
      ),
    onSuccess: (r) => {
      const line = r.items[0];
      toast.success(
        line?.changed
          ? t("adjusted", { sku: row.sku, before: line.onHandBefore, after: line.onHandAfter })
          : t("confirmed", { sku: row.sku }),
      );
      void queryClient.invalidateQueries({ queryKey: ["stock"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      onClose();
    },
    onError: (error) => showServerErrors(form, error),
  });

  return (
    <form className="grid gap-4" noValidate onSubmit={form.handleSubmit((v) => adjust.mutate(v))}>
      <FormBanner message={errors.root?.message} />
      <div className="flex items-start justify-between gap-3 rounded-lg border bg-surface-2 px-3 py-2">
        <div className="grid min-w-0 gap-0.5">
          <span className="font-mono text-sm text-text-900">{row.sku}</span>
          <span className="truncate text-[13px] text-text-500">{variantTitle(row)}</span>
        </div>
        {onChangeVariant ? (
          <Button type="button" variant="link" size="sm" onClick={onChangeVariant}>
            {t("changeVariant")}
          </Button>
        ) : null}
      </div>

      <Field id="adjust-warehouse" label={t("warehouse")} error={errors.warehouseId?.message}>
        <Controller
          control={form.control}
          name="warehouseId"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger {...fieldProps("adjust-warehouse", errors.warehouseId?.message)} className="w-full">
                <SelectValue placeholder={t("chooseWarehouse")} />
              </SelectTrigger>
              <SelectContent>
                {usable.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </Field>

      <Controller
        control={form.control}
        name="mode"
        render={({ field }) => (
          <RadioGroup
            value={field.value}
            onValueChange={(v) => field.onChange(v === "delta" ? "delta" : "set")}
            className="grid gap-2 sm:grid-cols-2"
          >
            {(["set", "delta"] as const).map((m) => (
              <div key={m} className="flex items-start gap-3 rounded-lg border p-3">
                <RadioGroupItem value={m} id={`adjust-mode-${m}`} className="mt-0.5" />
                <Label htmlFor={`adjust-mode-${m}`} className="grid gap-0.5 font-normal">
                  <span className="font-medium text-text-900">{t(`mode_${m}`)}</span>
                  <span className="text-[13px] text-text-500">{t(`modeHint_${m}`)}</span>
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}
      />

      <Field
        id="adjust-quantity"
        label={values.mode === "set" ? t("countedQuantity") : t("difference")}
        error={errors.quantity?.message}
        hint={t("onHandPreview", { before: formatNumber(before), after: after === null ? "…" : formatNumber(after) })}
      >
        <Input
          type="number"
          inputMode="numeric"
          step={1}
          className="tabular"
          {...fieldProps("adjust-quantity", errors.quantity?.message, true)}
          {...form.register("quantity")}
        />
      </Field>

      <Field id="adjust-reason" label={t("reason")} error={errors.reason?.message}>
        <Controller
          control={form.control}
          name="reason"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger {...fieldProps("adjust-reason", errors.reason?.message)} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ADJUST_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`reason_${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </Field>

      <Field
        id="adjust-note"
        label={values.reason === "other" ? t("noteRequiredLabel") : t("noteOptional")}
        error={errors.note?.message}
      >
        <Textarea
          rows={2}
          maxLength={500}
          {...fieldProps("adjust-note", errors.note?.message)}
          {...form.register("note")}
        />
      </Field>

      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" loading={adjust.isPending}>
          {t("adjustSubmit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
