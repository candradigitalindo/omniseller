"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FolderTree,
  Rocket,
  Trash2,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ChannelIcon } from "@/components/common/channel";
import { Field, fieldProps } from "@/components/common/field";
import { ErrorState, StatusPill } from "@/components/common/page";
import { Segmented } from "@/components/common/segmented";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useStores } from "@/features/stores/use-store-modes";
import { api, unwrap, unwrapWithEtag } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { formatRupiah } from "@/lib/format";
import { useCan } from "@/lib/session";
import { AttributeInput } from "./attribute-input";
import { CategoryPicker } from "./category-picker";
import {
  type AttributeValue,
  type CategoryRules,
  DRAFT_TONE,
  type Draft,
  type DraftProblem,
  draftPatch,
  type EditState,
  editable,
  editProblems,
  editState,
  problemsAt,
  publishable,
  requiredNow,
  sortedAttributes,
  working,
} from "./copy-meta";

const EMPTY_VALUE: AttributeValue = { valueIds: [], text: "", unit: "" };

/**
 * One draft before it is published (backend 8.25 step 3): its problems on top, then the category and its
 * rules, the product text, attributes, photos, package, and variants. Only what changed is saved, with
 * If-Match, and the api checks the problems again.
 */
export function DraftEditor({ id }: { id: string }) {
  const draft = useQuery({
    queryKey: ["listing-drafts", "detail", id],
    queryFn: () => unwrapWithEtag(api.GET("/v1/listing-drafts/{id}", { params: { path: { id } } })),
    // the worker is preparing or publishing it: look again until it is done
    refetchInterval: (q) => (q.state.data && working(q.state.data.data) ? 2_000 : false),
  });
  if (draft.isPending) {
    return (
      <div className="grid gap-4" aria-busy>
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (draft.isError) {
    return (
      <>
        <BackLink />
        <ErrorState error={draft.error} onRetry={() => draft.refetch()} />
      </>
    );
  }
  const d = draft.data.data;
  // a new version from the api starts the form over
  return <Editor key={`${d.rowVersion}|${d.status}`} draft={d} etag={draft.data.etag} />;
}

function BackLink() {
  const t = useTranslations("listingCopy");
  return (
    <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
      <Link href="/listing/salin?tab=draf">
        <ArrowLeft aria-hidden />
        {t("backToDrafts")}
      </Link>
    </Button>
  );
}

function Editor({ draft: d, etag }: { draft: Draft; etag: string | null }) {
  const t = useTranslations("listingCopy");
  const can = useCan();
  const queryClient = useQueryClient();
  const { byId } = useStores();
  const target = byId.get(d.targetStoreId);
  const [before] = useState(() => editState(d));
  const [s, setS] = useState<EditState>(before);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState(false);
  const canEdit = can("catalog:write") && editable(d);
  const patch = draftPatch(before, s);
  const dirty = Object.keys(patch).length > 0;
  const set = (p: Partial<EditState>) => setS((x) => ({ ...x, ...p }));

  const rules = useQuery({
    queryKey: ["categories", d.targetStoreId, "detail", d.externalCategoryId],
    queryFn: () =>
      unwrap(
        api.GET("/v1/stores/{id}/categories/{categoryId}", {
          params: { path: { id: d.targetStoreId, categoryId: d.externalCategoryId ?? "" } },
        }),
      ),
    enabled: d.externalCategoryId !== null,
    refetchInterval: (q) => (q.state.data?.rulesPending ? 2_000 : false),
  });
  const r = rules.data?.rules ?? null;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["listing-drafts"] });

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/v1/listing-drafts/{id}", {
          params: { path: { id: d.id } },
          ...(etag ? { headers: { "If-Match": etag } } : {}),
          body: patch,
        }),
      ),
    onSuccess: (saved) => {
      toast.success(
        saved.blockingProblems > 0 ? t("savedWithProblems", { count: saved.blockingProblems }) : t("saved"),
      );
      refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.errors.length > 0) {
        setErrors(Object.fromEntries(e.errors.map((x) => [x.path, x.message])));
      } else if (e instanceof ApiError && (e.status === 412 || e.code === "row.stale")) {
        setErrors({ root: t("stale") });
      } else setErrors({ root: errorMessage(e) });
    },
  });
  const publish = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/listing-drafts/publish", { body: { draftIds: [d.id] } })),
    onSuccess: (res) => {
      if (res.queued.length > 0) toast.success(t("publishQueued", { count: 1 }));
      else toast.error(res.refused[0]?.message ?? t("publishRefused"));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const category = useMutation({
    mutationFn: (categoryId: string) =>
      unwrap(api.POST("/v1/listing-drafts/category", { body: { draftIds: [d.id], categoryId } })),
    onSuccess: () => {
      toast.success(t("categoryChanged", { count: 1 }));
      setPicking(false);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const submit = () => {
    const found = Object.fromEntries(Object.entries(editProblems(s)).map(([k, p]) => [k, t(`edit_${p}`)]));
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate();
  };
  const fieldError = (field: string) => errors[field];
  const blocking = d.problems.filter((p) => p.blocking);
  const warnings = d.problems.filter((p) => !p.blocking);

  return (
    <div>
      <BackLink />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h1 className="text-[22px] leading-tight font-bold text-text-900 md:text-2xl">{d.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-text-500">
            <StatusPill tone={DRAFT_TONE[d.status]}>{t(`draftStatus_${d.status}`)}</StatusPill>
            {target ? (
              <span className="flex items-center gap-1.5">
                <ChannelIcon channel={target.channel} decorative />
                {target.name}
              </span>
            ) : null}
            {d.externalTargetItemId ? <span>{t("publishedAs", { id: d.externalTargetItemId })}</span> : null}
          </div>
        </div>
        {can("catalog:publish") && editable(d) ? (
          <Button
            disabled={!publishable(d) || dirty}
            loading={publish.isPending}
            onClick={() => publish.mutate()}
            title={dirty ? t("saveFirst") : undefined}
          >
            <Rocket aria-hidden />
            {t("publishOne")}
          </Button>
        ) : null}
      </div>

      {working(d) ? (
        <p className="mb-4 rounded-lg bg-primary-50 px-3 py-2.5 text-sm text-text-900" aria-live="polite">
          {t(d.status === "preparing" ? "workingPreparing" : "workingPublishing")}
        </p>
      ) : null}
      {d.status === "failed" && d.error ? (
        <p className="mb-4 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {t("failedBecause", { error: d.error })}
        </p>
      ) : null}

      {blocking.length + warnings.length > 0 && d.status !== "published" ? (
        <Card className="mb-4">
          <CardContent className="grid gap-3">
            {blocking.length > 0 ? (
              <ProblemList tone="danger" title={t("blockingTitle", { count: blocking.length })} problems={blocking} />
            ) : null}
            {warnings.length > 0 ? (
              <ProblemList tone="warning" title={t("warningTitle", { count: warnings.length })} problems={warnings} />
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4">
        <Section id="field-category" title={t("sectionCategory")} problems={problemsAt(d.problems, "category")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-0.5 text-sm">
              <span className={cn(d.categoryPath ? "text-text-900" : "text-warning")}>
                {d.categoryPath ?? t("noCategory")}
              </span>
              <span className="text-[13px] text-text-500">
                {t("sourceCategory", { path: d.source.categoryPath ?? d.source.categoryId })}
              </span>
            </div>
            {canEdit ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPicking(true)}
                disabled={dirty}
                title={dirty ? t("saveFirst") : undefined}
              >
                <FolderTree aria-hidden />
                {t("changeCategory")}
              </Button>
            ) : null}
          </div>
          {rules.data?.rulesPending ? (
            <p className="text-[13px] text-text-500" aria-live="polite">
              {t("rulesLoading")}
            </p>
          ) : null}
        </Section>

        <Section
          title={t("sectionInfo")}
          problems={[
            ...problemsAt(d.problems, "title"),
            ...problemsAt(d.problems, "description"),
            ...problemsAt(d.problems, "brand"),
          ]}
        >
          <Field
            id="field-title"
            label={t("titleLabel")}
            hint={
              r
                ? t("lengthHint", { length: s.title.trim().length, min: r.limits.titleMin, max: r.limits.titleMax })
                : undefined
            }
            error={fieldError("title")}
          >
            <Input
              value={s.title}
              disabled={!canEdit}
              onChange={(e) => set({ title: e.target.value })}
              {...fieldProps("field-title", fieldError("title"), !!r)}
            />
          </Field>
          <Field
            id="field-description"
            label={t("descriptionLabel")}
            hint={
              r
                ? t("lengthHint", {
                    length: s.description.length,
                    min: r.limits.descriptionMin,
                    max: r.limits.descriptionMax,
                  })
                : undefined
            }
            error={fieldError("description")}
          >
            <Textarea
              value={s.description}
              rows={6}
              disabled={!canEdit}
              onChange={(e) => set({ description: e.target.value })}
              {...fieldProps("field-description", fieldError("description"), !!r)}
            />
          </Field>
          {d.descriptionHtml ? <p className="text-[13px] text-text-500">{t("descriptionHtmlNote")}</p> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="field-brand"
              label={t("brandLabel")}
              hint={r?.brandRequired ? t("brandRequired") : t("brandHint", { source: d.source.brand ?? "—" })}
            >
              <Input
                value={s.brand}
                disabled={!canEdit}
                onChange={(e) => set({ brand: e.target.value })}
                {...fieldProps("field-brand", undefined, true)}
              />
            </Field>
            <Field id="field-item-sku" label={t("itemSkuLabel")}>
              <Input
                value={s.itemSku}
                disabled={!canEdit}
                onChange={(e) => set({ itemSku: e.target.value })}
                {...fieldProps("field-item-sku", undefined)}
              />
            </Field>
            <div className="grid gap-1.5">
              <span className="text-sm font-medium text-text-700">{t("conditionLabel")}</span>
              {/* its own width, not the grid cell's */}
              <div>
                <Segmented
                  label={t("conditionLabel")}
                  value={s.condition}
                  onChange={(condition) => canEdit && set({ condition })}
                  options={[
                    { value: "new", label: t("condition_new") },
                    { value: "used", label: t("condition_used") },
                  ]}
                />
              </div>
            </div>
            <Field
              id="field-preorder"
              label={t("preOrderLabel")}
              hint={t("preOrderHint")}
              error={fieldError("preOrderDays")}
            >
              <Input
                value={s.preOrderDays}
                inputMode="numeric"
                disabled={!canEdit}
                onChange={(e) => set({ preOrderDays: e.target.value })}
                {...fieldProps("field-preorder", fieldError("preOrderDays"), true)}
              />
            </Field>
          </div>
        </Section>

        <Section title={t("sectionAttributes")} problems={[]}>
          {r ? (
            <Attributes
              rules={r}
              state={s}
              draft={d}
              disabled={!canEdit}
              onChange={(attributes) => set({ attributes })}
            />
          ) : (
            <p className="text-sm text-text-500">
              {d.externalCategoryId ? t("rulesLoading") : t("attributesNeedCategory")}
            </p>
          )}
        </Section>

        <Section title={t("sectionImages")} problems={problemsAt(d.problems, "images")}>
          <Images draft={d} order={s.images} disabled={!canEdit} onChange={(images) => set({ images })} rules={r} />
        </Section>

        <Section
          title={t("sectionPackage")}
          problems={[...problemsAt(d.problems, "weight"), ...problemsAt(d.problems, "dimensions")]}
        >
          <div className="grid gap-4 sm:grid-cols-4">
            <Field id="field-weight" label={t("weightLabel")} error={fieldError("weight")}>
              <Input
                value={s.weightG}
                inputMode="numeric"
                disabled={!canEdit}
                onChange={(e) => set({ weightG: e.target.value })}
                {...fieldProps("field-weight", fieldError("weight"))}
              />
            </Field>
            {(["length", "width", "height"] as const).map((k) => (
              <Field
                key={k}
                id={`field-${k}`}
                label={t(`${k}Label`)}
                error={k === "length" ? fieldError("dimensions") : undefined}
              >
                <Input
                  value={s[k]}
                  inputMode="numeric"
                  disabled={!canEdit}
                  onChange={(e) => set({ [k]: e.target.value })}
                  {...fieldProps(`field-${k}`, k === "length" ? fieldError("dimensions") : undefined)}
                />
              </Field>
            ))}
          </div>
          <p className="text-[13px] text-text-500">
            {r?.dimensionsRequired ? t("dimensionsRequired") : t("dimensionsHint")}
          </p>
        </Section>

        <Section
          title={t("sectionVariants", { count: s.variants.length })}
          problems={[...problemsAt(d.problems, "variationNames"), ...problemsAt(d.problems, "variants")]}
        >
          <Variants draft={d} state={s} errors={errors} disabled={!canEdit} onChange={set} />
        </Section>
      </div>

      {canEdit ? (
        // sticks to the bottom of the screen while the form scrolls; above the phone's bottom navigation
        <div className="sticky bottom-16 z-20 -mx-4 mt-4 border-t bg-surface/95 px-4 py-3 backdrop-blur md:bottom-4 md:mx-0 md:rounded-[10px] md:border md:shadow-float">
          <div className="flex flex-wrap items-center justify-end gap-3">
            {errors.root ? (
              <p role="alert" className="mr-auto text-sm text-danger">
                {errors.root}
              </p>
            ) : dirty ? (
              <span className="text-sm text-text-500">{t("unsaved")}</span>
            ) : null}
            <Button
              variant="secondary"
              disabled={!dirty || save.isPending}
              onClick={() => {
                setS(before);
                setErrors({});
              }}
            >
              {t("discard")}
            </Button>
            <Button disabled={!dirty} loading={save.isPending} onClick={submit}>
              {t("save")}
            </Button>
          </div>
        </div>
      ) : null}

      {canEdit ? (
        <CategoryPicker
          open={picking}
          storeId={d.targetStoreId}
          title={t("changeCategoryOf", { count: 1 })}
          busy={category.isPending}
          onPick={(c) => category.mutate(c.categoryId)}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}

function Section({
  id,
  title,
  problems,
  children,
}: {
  id?: string;
  title: string;
  problems: DraftProblem[];
  children: ReactNode;
}) {
  return (
    <Card id={id}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {problems.length > 0 ? <InlineProblems problems={problems} /> : null}
        {children}
      </CardContent>
    </Card>
  );
}

function InlineProblems({ problems }: { problems: DraftProblem[] }) {
  return (
    <ul className="grid gap-1">
      {problems.map((p) => (
        <li
          key={`${p.field}|${p.code}`}
          className={cn("flex items-start gap-1.5 text-sm", p.blocking ? "text-danger" : "text-warning")}
        >
          {p.blocking ? (
            <AlertOctagon className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          )}
          {p.message}
        </li>
      ))}
    </ul>
  );
}

function ProblemList({
  tone,
  title,
  problems,
}: {
  tone: "danger" | "warning";
  title: string;
  problems: DraftProblem[];
}) {
  return (
    <div
      className={cn(
        "grid gap-1.5 rounded-lg px-3 py-2.5 text-sm",
        tone === "danger" ? "bg-danger-soft" : "bg-warning-soft",
      )}
    >
      <p className={cn("font-medium", tone === "danger" ? "text-danger" : "text-warning")}>{title}</p>
      <ul className="list-disc pl-5 text-text-900">
        {problems.map((p) => (
          <li key={`${p.field}|${p.code}`}>{p.message}</li>
        ))}
      </ul>
    </div>
  );
}

function Attributes({
  rules,
  state,
  draft: d,
  disabled,
  onChange,
}: {
  rules: CategoryRules;
  state: EditState;
  draft: Draft;
  disabled: boolean;
  onChange: (attributes: EditState["attributes"]) => void;
}) {
  const t = useTranslations("listingCopy");
  const [showAll, setShowAll] = useState(false);
  const all = sortedAttributes(rules);
  const needed = all.filter((a) => requiredNow(a, state.attributes));
  const others = all.filter((a) => !requiredNow(a, state.attributes));
  const hasProblem = (a: (typeof all)[number]) => problemsAt(d.problems, `attributes.${a.attributeId}`).length > 0;
  // optional attributes with a value or a problem stay visible
  const shown = showAll
    ? others
    : others.filter(
        (a) =>
          hasProblem(a) ||
          (state.attributes[a.attributeId] ?? EMPTY_VALUE).valueIds.length > 0 ||
          (state.attributes[a.attributeId]?.text ?? "") !== "",
      );
  const row = (a: (typeof all)[number], required: boolean) => {
    const id = `field-attributes-${a.attributeId}`;
    const problems = problemsAt(d.problems, `attributes.${a.attributeId}`);
    return (
      <div key={a.attributeId} className="grid gap-1.5">
        <Label htmlFor={id} id={`${id}-label`} className="text-sm font-medium text-text-700">
          {a.name}
          {required ? <span className="text-danger"> *</span> : null}
        </Label>
        <AttributeInput
          id={id}
          attribute={a}
          value={state.attributes[a.attributeId] ?? EMPTY_VALUE}
          disabled={disabled}
          invalid={problems.some((p) => p.blocking)}
          onChange={(v) => onChange({ ...state.attributes, [a.attributeId]: v })}
        />
        {problems.length > 0 ? <InlineProblems problems={problems} /> : null}
      </div>
    );
  };
  return (
    <div className="grid gap-4">
      {needed.length === 0 ? <p className="text-sm text-text-500">{t("noRequiredAttributes")}</p> : null}
      <div className="grid gap-4 sm:grid-cols-2">{needed.map((a) => row(a, true))}</div>
      {shown.length > 0 ? <div className="grid gap-4 sm:grid-cols-2">{shown.map((a) => row(a, false))}</div> : null}
      {others.length > shown.length || showAll ? (
        <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setShowAll((v) => !v)}>
          {showAll ? t("fewerAttributes") : t("moreAttributes", { count: others.length - shown.length })}
        </Button>
      ) : null}
    </div>
  );
}

function Images({
  draft: d,
  order,
  disabled,
  onChange,
  rules,
}: {
  draft: Draft;
  order: string[];
  disabled: boolean;
  onChange: (images: string[]) => void;
  rules: CategoryRules | null;
}) {
  const t = useTranslations("listingCopy");
  const move = (i: number, by: number) => {
    const next = [...order];
    const [x] = next.splice(i, 1);
    if (x) next.splice(i + by, 0, x);
    onChange(next);
  };
  const uploaded = new Map(d.images.map((im) => [im.sourceUrl, im.uploaded]));
  return (
    <div className="grid gap-3">
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5">
        {order.map((url, i) => (
          <li key={url} className="grid gap-1.5">
            <div className="relative">
              <Image
                src={url}
                alt={t("photoAlt", { n: i + 1 })}
                width={160}
                height={160}
                unoptimized
                className="aspect-square w-full rounded-lg border object-cover"
              />
              {i === 0 ? (
                <span className="absolute top-1.5 left-1.5 rounded bg-surface/90 px-1.5 text-[11px] font-medium text-text-900">
                  {t("mainPhoto")}
                </span>
              ) : null}
            </div>
            {!disabled ? (
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("photoLeft", { n: i + 1 })}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ChevronLeft aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("photoRemove", { n: i + 1 })}
                  onClick={() => onChange(order.filter((u) => u !== url))}
                >
                  <Trash2 aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("photoRight", { n: i + 1 })}
                  disabled={i === order.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ChevronRight aria-hidden />
                </Button>
              </div>
            ) : uploaded.get(url) ? (
              <span className="text-center text-[12px] text-success">{t("uploaded")}</span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-text-500">
        {rules
          ? t("photosHint", { count: order.length, min: rules.limits.imagesMin, max: rules.limits.imagesMax })
          : t("photosOnly")}
      </p>
    </div>
  );
}

function Variants({
  draft: d,
  state: s,
  errors,
  disabled,
  onChange,
}: {
  draft: Draft;
  state: EditState;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (p: Partial<EditState>) => void;
}) {
  const t = useTranslations("listingCopy");
  const linked = new Map(d.variants.map((v) => [v.key, v.variantId]));
  const setVariant = (key: string, p: Partial<EditState["variants"][number]>) =>
    onChange({ variants: s.variants.map((v) => (v.key === key ? { ...v, ...p } : v)) });
  return (
    <div className="grid gap-4">
      {s.variationNames.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {s.variationNames.map((name, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a draft keeps its number of variations; the position is the variation
            <Field key={`variation-${i}`} id={`field-variation-${i}`} label={t("variationName", { n: i + 1 })}>
              <Input
                value={name}
                disabled={disabled}
                onChange={(e) =>
                  onChange({ variationNames: s.variationNames.map((x, j) => (j === i ? e.target.value : x)) })
                }
                {...fieldProps(`field-variation-${i}`, undefined)}
              />
            </Field>
          ))}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader className="bg-surface-2">
            <TableRow>
              {s.variationNames.map((n, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a draft keeps its number of variations; the position is the variation
                <TableHead key={`h-${i}`}>{n || t("variationName", { n: i + 1 })}</TableHead>
              ))}
              <TableHead>{t("colSku")}</TableHead>
              <TableHead className="text-right">{t("colPrice")}</TableHead>
              <TableHead>{t("colLinked")}</TableHead>
              {!disabled ? <TableHead className="w-px" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.variants.map((v) => {
              const problems = problemsAt(d.problems, `variants.${v.key}`);
              return (
                <TableRow key={v.key} className="align-top">
                  {v.options.map((o, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: one option per variation, in the variations' order
                    <TableCell key={`${v.key}-o${i}`} className="min-w-32">
                      <Input
                        value={o}
                        disabled={disabled}
                        aria-label={t("optionOf", { name: s.variationNames[i] ?? "", n: i + 1 })}
                        onChange={(e) =>
                          setVariant(v.key, { options: v.options.map((x, j) => (j === i ? e.target.value : x)) })
                        }
                        className="h-8"
                      />
                    </TableCell>
                  ))}
                  <TableCell className="min-w-40">
                    <Input
                      value={v.sku}
                      disabled={disabled}
                      aria-label={t("skuOf", { options: v.options.join(" ") || v.key })}
                      aria-invalid={problems.some((p) => p.field.endsWith(".sku") && p.blocking) || undefined}
                      onChange={(e) => setVariant(v.key, { sku: e.target.value })}
                      className="h-8 font-mono"
                    />
                    {problems.length > 0 ? (
                      <div className="mt-1">
                        <InlineProblems problems={problems} />
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="min-w-36">
                    <Input
                      currency
                      value={v.price}
                      inputMode="numeric"
                      disabled={disabled}
                      aria-label={t("priceOf", { options: v.options.join(" ") || v.key })}
                      aria-invalid={errors[`variants.${v.key}.price`] ? true : undefined}
                      onChange={(e) => setVariant(v.key, { price: e.target.value })}
                      className="h-8 text-right"
                    />
                    {errors[`variants.${v.key}.price`] ? (
                      <p className="mt-1 text-[13px] text-danger">{errors[`variants.${v.key}.price`]}</p>
                    ) : (
                      <p className="mt-1 text-right text-[12px] text-text-500">{formatRupiah(Number(v.price) || 0)}</p>
                    )}
                  </TableCell>
                  <TableCell>
                    {linked.get(v.key) ? (
                      <StatusPill tone="success">{t("linked")}</StatusPill>
                    ) : (
                      <StatusPill tone="warning">{t("notLinked")}</StatusPill>
                    )}
                  </TableCell>
                  {!disabled ? (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={s.variants.length <= 1}
                        aria-label={t("removeVariant", { options: v.options.join(" ") || v.key })}
                        onClick={() => onChange({ variants: s.variants.filter((x) => x.key !== v.key) })}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
