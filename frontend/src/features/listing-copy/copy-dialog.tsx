"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChannelIcon } from "@/components/common/channel";
import { Field, fieldProps } from "@/components/common/field";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useStores } from "@/features/stores/use-store-modes";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";

const MAX_TARGETS = 10;
const MAX_ITEMS = 500;
const PERCENT = /^-?\d+(\.\d+)?$/;

type Picked = { listingId: string; itemId: string; title: string };

/**
 * "Salin listing" (FR-PRD-13, backend 8.25): from one of the seller's marketplace stores, the whole store
 * or chosen products, to up to ten others, with a price change in percent. The worker turns each product
 * into a draft to review before anything reaches a marketplace.
 */
export function CopyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("listingCopy");
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{t("copyTitle")}</DialogTitle>
          <DialogDescription>{t("copyBody")}</DialogDescription>
        </DialogHeader>
        {open ? <CopyForm onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CopyForm({ onClose }: { onClose: () => void }) {
  const t = useTranslations("listingCopy");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const { byId } = useStores();
  const stores = [...byId.values()].filter((s) => s.channel !== "manual" && s.status !== "disconnected");
  const [sourceId, setSourceId] = useState("");
  const [scope, setScope] = useState<"store" | "items">("store");
  const [picked, setPicked] = useState<Picked[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [percent, setPercent] = useState("0");
  const [skipListed, setSkipListed] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [key] = useState(() => crypto.randomUUID());

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/listing-copies", {
          params: { header: { "Idempotency-Key": key } },
          body: {
            sourceStoreId: sourceId,
            ...(scope === "items" ? { listingIds: picked.map((p) => p.listingId) } : {}),
            targetStoreIds: targets,
            priceChangePercent: Number(percent),
            skipListed,
          },
        }),
      ),
    onSuccess: (r) => {
      toast.success(t("copyStarted", { count: r.items.length }));
      void queryClient.invalidateQueries({ queryKey: ["listing-copies"] });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.errors.length > 0) {
        setErrors(Object.fromEntries(error.errors.map((e) => [e.path.split(".")[0] ?? e.path, e.message])));
      } else setErrors({ root: errorMessage(error) });
    },
  });

  if (stores.length < 2) return <p className="text-sm text-text-700">{t("needTwoStores")}</p>;

  const others = stores.filter((s) => s.id !== sourceId);
  const readOnlyTargets = others.filter((s) => targets.includes(s.id) && s.syncMode === "read_only");
  const validate = () => {
    const out: Record<string, string> = {};
    if (!sourceId) out.sourceStoreId = t("pickSource");
    if (scope === "items" && picked.length === 0) out.listingIds = t("pickItems");
    if (targets.length === 0) out.targetStoreIds = t("pickTargets");
    if (!PERCENT.test(percent.trim()) || Number(percent) < -90 || Number(percent) > 500)
      out.priceChangePercent = t("percentRange");
    return out;
  };

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
      <Field id="copy-source" label={t("source")} error={errors.sourceStoreId}>
        <Select
          value={sourceId}
          onValueChange={(v) => {
            setSourceId(v);
            setPicked([]);
            setTargets((ts) => ts.filter((x) => x !== v));
          }}
        >
          <SelectTrigger id="copy-source" className="w-full" aria-invalid={errors.sourceStoreId ? true : undefined}>
            <SelectValue placeholder={t("sourcePlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {stores.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                <ChannelIcon channel={s.channel} decorative />
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="grid gap-2">
        <Segmented
          block
          label={t("scope")}
          value={scope}
          onChange={setScope}
          options={[
            { value: "store", label: t("scopeStore") },
            { value: "items", label: t("scopeItems") },
          ]}
        />
        {scope === "items" ? (
          sourceId ? (
            <ItemPicker storeId={sourceId} picked={picked} onChange={setPicked} error={errors.listingIds} />
          ) : (
            <p className="text-sm text-text-500">{t("pickSourceFirst")}</p>
          )
        ) : (
          <p className="text-sm text-text-500">{t("scopeStoreHint")}</p>
        )}
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-text-700">{t("targets")}</legend>
        {others.length === 0 ? <p className="text-sm text-text-500">{t("pickSourceFirst")}</p> : null}
        {others.map((s) => {
          const checked = targets.includes(s.id);
          return (
            <Label
              key={s.id}
              htmlFor={`target-${s.id}`}
              className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary-50"
            >
              <Checkbox
                id={`target-${s.id}`}
                checked={checked}
                disabled={!checked && targets.length >= MAX_TARGETS}
                onCheckedChange={(v) => setTargets((ts) => (v ? [...ts, s.id] : ts.filter((x) => x !== s.id)))}
              />
              <ChannelIcon channel={s.channel} decorative />
              <span className="text-sm text-text-900">{s.name}</span>
            </Label>
          );
        })}
        {errors.targetStoreIds ? (
          <p role="alert" className="text-sm text-danger">
            {errors.targetStoreIds}
          </p>
        ) : null}
        {readOnlyTargets.length > 0 ? (
          <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-text-900">
            {t("readOnlyTargets", { names: readOnlyTargets.map((s) => s.name).join(", ") })}
          </p>
        ) : null}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="copy-percent" label={t("priceChange")} hint={t("priceChangeHint")} error={errors.priceChangePercent}>
          <div className="relative">
            <Input
              value={percent}
              inputMode="decimal"
              onChange={(e) => setPercent(e.target.value)}
              className="pr-8"
              {...fieldProps("copy-percent", errors.priceChangePercent, true)}
            />
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-text-500">
              %
            </span>
          </div>
        </Field>
        <div className="flex items-start justify-between gap-3 pt-7">
          <Label htmlFor="copy-skip" className="grid gap-0.5 font-normal">
            <span className="text-sm text-text-900">{t("skipListed")}</span>
            <span className="text-[13px] text-text-500">{t("skipListedHint")}</span>
          </Label>
          <Switch id="copy-skip" checked={skipListed} onCheckedChange={setSkipListed} />
        </div>
      </div>

      {errors.root ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {errors.root}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" loading={create.isPending}>
          {t("copySubmit", { count: Math.max(targets.length, 1) })}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Products of the source store, one row per marketplace item (its listings are per variant). */
function ItemPicker({
  storeId,
  picked,
  onChange,
  error,
}: {
  storeId: string;
  picked: Picked[];
  onChange: (picked: Picked[]) => void;
  error: string | undefined;
}) {
  const t = useTranslations("listingCopy");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);
  const listings = useQuery({
    queryKey: ["listings", "copy-pick", storeId, term],
    queryFn: () =>
      unwrap(
        api.GET("/v1/listings", {
          params: { query: { storeId, limit: 100, ...(term ? { q: term } : {}) } },
        }),
      ),
  });
  const items = [
    ...new Map(
      (listings.data?.items ?? [])
        .filter((l) => l.status !== "deleted")
        .map((l) => [
          l.externalItemId,
          { listingId: l.id, itemId: l.externalItemId, title: l.title, imageUrl: l.imageUrl },
        ]),
    ).values(),
  ];
  const chosen = new Set(picked.map((p) => p.itemId));
  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-500"
          aria-hidden
        />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("itemSearch")}
          aria-label={t("itemSearch")}
          className="pl-9"
        />
      </div>
      <ul className="grid max-h-56 gap-0.5 overflow-y-auto rounded-lg border p-1" aria-label={t("itemsOfStore")}>
        {items.length === 0 && listings.isSuccess ? (
          <li className="px-3 py-2 text-sm text-text-500">{t("noItems")}</li>
        ) : null}
        {items.map((it) => (
          <li key={it.itemId}>
            <Label
              htmlFor={`item-${it.itemId}`}
              className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 font-normal hover:bg-surface-2"
            >
              <Checkbox
                id={`item-${it.itemId}`}
                checked={chosen.has(it.itemId)}
                disabled={!chosen.has(it.itemId) && picked.length >= MAX_ITEMS}
                onCheckedChange={(v) => onChange(v ? [...picked, it] : picked.filter((p) => p.itemId !== it.itemId))}
              />
              {it.imageUrl ? (
                <Image
                  src={it.imageUrl}
                  alt=""
                  width={32}
                  height={32}
                  unoptimized
                  className="size-8 rounded border object-cover"
                />
              ) : (
                <span className="size-8 rounded bg-surface-2" aria-hidden />
              )}
              <span className="truncate text-sm text-text-900">{it.title}</span>
            </Label>
          </li>
        ))}
      </ul>
      {picked.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {picked.map((p) => (
            <span
              key={p.itemId}
              className="inline-flex max-w-60 items-center gap-1 rounded-full bg-primary-100 py-0.5 pr-1 pl-2.5 text-[13px] text-primary-600"
            >
              <span className="truncate">{p.title}</span>
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-primary-50"
                aria-label={t("unpick", { title: p.title })}
                onClick={() => onChange(picked.filter((x) => x.itemId !== p.itemId))}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <p className={error ? "text-sm text-danger" : "text-[13px] text-text-500"} role={error ? "alert" : undefined}>
        {error ?? t("itemsPicked", { count: picked.length })}
      </p>
    </div>
  );
}
