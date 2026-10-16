"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Field, fieldProps } from "@/components/common/field";
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
import { formatNumber } from "@/lib/format";
import { useCan } from "@/lib/session";

type VariantRow = { key: number; sku: string; name: string; basePrice: string; costPrice: string; weightG: string };

const WHOLE = /^\d+$/;

/**
 * "Tambah produk" by hand (L13): the product's name and SKU, and one row per variant with its SKU, price,
 * cost (finance:read only), and weight. Everything else is edited afterwards on L14.
 */
export function ProductCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("products");
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createBody")}</DialogDescription>
        </DialogHeader>
        {open ? <CreateForm onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({ onClose }: { onClose: () => void }) {
  const t = useTranslations("products");
  const tCommon = useTranslations("common");
  const can = useCan();
  const router = useRouter();
  const queryClient = useQueryClient();
  const seesCost = can("finance:read");
  const nextKey = useRef(1);
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [rows, setRows] = useState<VariantRow[]>([
    { key: 0, sku: "", name: "", basePrice: "", costPrice: "", weightG: "" },
  ]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/products", {
          body: {
            sku: sku.trim(),
            name: name.trim(),
            variants: rows.map((r) => ({
              sku: r.sku.trim(),
              ...(r.name.trim() ? { name: r.name.trim() } : {}),
              basePrice: Number(r.basePrice),
              ...(seesCost && r.costPrice.trim() ? { costPrice: Number(r.costPrice) } : {}),
              weightG: Number(r.weightG),
            })),
          },
        }),
      ),
    onSuccess: (product) => {
      toast.success(t("created", { name: product.name }));
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      onClose();
      router.push(`/produk/${product.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.errors.length > 0) {
        setErrors(Object.fromEntries(error.errors.map((e) => [e.path, e.message])));
      } else {
        setErrors({ root: errorMessage(error) });
      }
    },
  });

  const validate = (): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!name.trim()) out.name = t("required");
    if (!sku.trim()) out.sku = t("required");
    const seen = new Set<string>();
    rows.forEach((r, i) => {
      if (!r.sku.trim()) out[`variants.${i}.sku`] = t("required");
      else if (seen.has(r.sku.trim().toLowerCase())) out[`variants.${i}.sku`] = t("skuRepeated");
      seen.add(r.sku.trim().toLowerCase());
      if (!WHOLE.test(r.basePrice.trim())) out[`variants.${i}.basePrice`] = t("wholeRupiah");
      if (r.costPrice.trim() && !WHOLE.test(r.costPrice.trim())) out[`variants.${i}.costPrice`] = t("wholeRupiah");
      if (!WHOLE.test(r.weightG.trim()) || Number(r.weightG) < 1) out[`variants.${i}.weightG`] = t("weightRequired");
    });
    return out;
  };
  const set = (key: number, patch: Partial<VariantRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const found = validate();
        setErrors(found);
        if (Object.keys(found).length === 0) create.mutate();
      }}
    >
      {errors.root ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {errors.root}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <Field id="product-name" label={t("name")} error={errors.name}>
          <Input
            value={name}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
            {...fieldProps("product-name", errors.name)}
          />
        </Field>
        <Field id="product-sku" label={t("parentSku")} error={errors.sku}>
          <Input
            value={sku}
            maxLength={64}
            className="font-mono"
            onChange={(e) => setSku(e.target.value)}
            {...fieldProps("product-sku", errors.sku)}
          />
        </Field>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-text-700">{t("variantsTitle")}</legend>
        {rows.map((r, i) => (
          <div key={r.key} className="grid gap-2 rounded-lg border p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Field id={`v${r.key}-sku`} label={t("variantSku")} error={errors[`variants.${i}.sku`]}>
                <Input
                  className="font-mono"
                  maxLength={64}
                  value={r.sku}
                  onChange={(e) => set(r.key, { sku: e.target.value })}
                  {...fieldProps(`v${r.key}-sku`, errors[`variants.${i}.sku`])}
                />
              </Field>
              <Field id={`v${r.key}-name`} label={t("variantName")}>
                <Input
                  maxLength={255}
                  value={r.name}
                  placeholder={t("variantNamePlaceholder")}
                  onChange={(e) => set(r.key, { name: e.target.value })}
                  id={`v${r.key}-name`}
                />
              </Field>
            </div>
            <div className={seesCost ? "grid grid-cols-3 gap-2" : "grid grid-cols-2 gap-2"}>
              <Field id={`v${r.key}-price`} label={t("price")} error={errors[`variants.${i}.basePrice`]}>
                <Input
                  currency
                  inputMode="numeric"
                  className="tabular"
                  value={r.basePrice}
                  onChange={(e) => set(r.key, { basePrice: e.target.value })}
                  {...fieldProps(`v${r.key}-price`, errors[`variants.${i}.basePrice`])}
                />
              </Field>
              {seesCost ? (
                <Field id={`v${r.key}-cost`} label={t("cost")} error={errors[`variants.${i}.costPrice`]}>
                  <Input
                    currency
                    inputMode="numeric"
                    className="tabular"
                    value={r.costPrice}
                    onChange={(e) => set(r.key, { costPrice: e.target.value })}
                    {...fieldProps(`v${r.key}-cost`, errors[`variants.${i}.costPrice`])}
                  />
                </Field>
              ) : null}
              <Field id={`v${r.key}-weight`} label={t("weightG")} error={errors[`variants.${i}.weightG`]}>
                <Input
                  inputMode="numeric"
                  className="tabular"
                  value={r.weightG}
                  onChange={(e) => set(r.key, { weightG: e.target.value })}
                  {...fieldProps(`v${r.key}-weight`, errors[`variants.${i}.weightG`])}
                />
              </Field>
            </div>
            {rows.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="justify-self-end"
                onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
              >
                <Trash2 aria-hidden />
                {t("removeVariant")}
              </Button>
            ) : null}
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="justify-self-start"
          disabled={rows.length >= 200}
          onClick={() =>
            setRows((prev) => [
              ...prev,
              {
                key: nextKey.current++,
                sku: "",
                name: "",
                basePrice: prev.at(-1)?.basePrice ?? "",
                costPrice: prev.at(-1)?.costPrice ?? "",
                weightG: prev.at(-1)?.weightG ?? "",
              },
            ])
          }
        >
          <Plus aria-hidden />
          {t("addVariant")}
        </Button>
      </fieldset>

      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" loading={create.isPending}>
          {t("createSubmit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

type Summary = {
  rows: number;
  products: { created: number; updated: number };
  variants: { created: number; updated: number };
};

/**
 * "Impor CSV" (FR-PRD-04): the file is checked first without saving (`dryRun`), the counts shown, then
 * imported in one go. Every row error comes back at once, with its row number.
 */
export function ProductImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("products");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [preview, setPreview] = useState<Summary | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const reset = () => {
    setFile(null);
    setPreview(null);
    setProblems([]);
  };
  const send = useMutation({
    mutationFn: (input: { content: string; dryRun: boolean }) =>
      unwrap(api.POST("/v1/products/import", { body: input })),
    onSuccess: (summary) => {
      if (summary.dryRun) {
        setPreview(summary);
        return;
      }
      toast.success(
        t("imported", {
          products: summary.products.created + summary.products.updated,
          variants: summary.variants.created + summary.variants.updated,
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      reset();
      onClose();
    },
    onError: (error) => {
      setPreview(null);
      setProblems(
        error instanceof ApiError && error.errors.length > 0
          ? error.errors.slice(0, 50).map((e) => `${e.path}: ${e.message}`)
          : [errorMessage(error)],
      );
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("importTitle")}</DialogTitle>
          <DialogDescription>{t("importBody")}</DialogDescription>
        </DialogHeader>
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={async (e) => {
            const picked = e.target.files?.[0];
            e.target.value = "";
            if (!picked) return;
            setPreview(null);
            setProblems([]);
            const content = await picked.text();
            setFile({ name: picked.name, content });
            send.mutate({ content, dryRun: true });
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => input.current?.click()}
            loading={send.isPending && !preview}
          >
            <FileUp aria-hidden />
            {file ? t("chooseOtherFile") : t("chooseFile")}
          </Button>
          {file ? <span className="truncate text-sm text-text-700">{file.name}</span> : null}
        </div>
        <a href="/v1/products/export" className="text-sm font-medium text-primary hover:underline">
          {t("templateHint")}
        </a>
        {problems.length > 0 ? (
          <div role="alert" className="grid gap-1 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
            <span className="font-medium">{t("importProblems", { count: problems.length })}</span>
            <ul className="grid max-h-48 list-disc gap-0.5 overflow-y-auto pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview ? (
          <p className="rounded-lg bg-success-soft px-3 py-2.5 text-sm text-text-900">
            {t("importPreview", {
              rows: formatNumber(preview.rows),
              productsNew: formatNumber(preview.products.created),
              productsChanged: formatNumber(preview.products.updated),
              variantsNew: formatNumber(preview.variants.created),
              variantsChanged: formatNumber(preview.variants.updated),
            })}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            {tCommon("cancel")}
          </Button>
          <Button
            disabled={!preview}
            loading={send.isPending && preview !== null}
            onClick={() => file && send.mutate({ content: file.content, dryRun: false })}
          >
            {t("importSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
