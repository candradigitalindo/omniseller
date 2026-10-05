"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { ArrowLeft, Check, Download, FileSpreadsheet, Upload } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { ErrorState, StatusPill } from "@/components/common/page";
import { Segmented } from "@/components/common/segmented";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fileToBase64 } from "@/lib/file";
import { formatNumber, formatRelative } from "@/lib/format";
import { useTimeZone } from "@/lib/session";
import {
  columnLabel,
  IMPORT_ACCEPT,
  IMPORT_TONE,
  type ImportField,
  type ImportJob,
  importStep,
  importWorking,
  MAX_HEADER_ROW,
  MAX_IMPORT_BYTES,
  type Mapping,
  mappingBody,
  missingRequired,
  type SourceApp,
  sharedColumns,
} from "./migration-meta";

const UNUSED = "unused";
const NO_PRESET = "none";

function useFields() {
  return useQuery({
    queryKey: ["migration", "fields"],
    queryFn: () => unwrap(api.GET("/v1/migration/fields")),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** L46 steps 1 to 3: products from another app's export, checked in full before anything is written. */
export function ImportTab() {
  const { params } = useUrlParams();
  const job = params.get("job");
  return job ? (
    <ImportJobPanel key={job} id={job} />
  ) : (
    <div className="grid gap-4">
      <ImportStart />
      <ImportHistory />
    </div>
  );
}

function ImportStart() {
  const t = useTranslations("migration");
  const { set } = useUrlParams();
  const fields = useFields();
  const [app, setApp] = useState<SourceApp | null>(null);
  const [presetId, setPresetId] = useState(NO_PRESET);
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const presets = useQuery({
    queryKey: ["migration", "presets"],
    queryFn: () => unwrap(api.GET("/v1/migration/presets")),
  });
  const queryClient = useQueryClient();
  const upload = useMutation({
    mutationFn: async () => {
      if (!app || !file) throw new Error("unreachable");
      return unwrap(
        api.POST("/v1/migration/imports", {
          body: {
            sourceApp: app,
            fileName: file.name,
            content: await fileToBase64(file),
            ...(presetId !== NO_PRESET ? { presetId } : {}),
          },
        }),
      );
    },
    onSuccess: (job) => {
      void queryClient.invalidateQueries({ queryKey: ["migration", "imports"] });
      set({ job: job.id });
    },
    onError: (e) => setProblem(errorMessage(e)),
  });
  const ownPresets = (presets.data?.items ?? []).filter((p) => p.sourceApp === app);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("startTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium text-text-700">{t("sourceApp")}</legend>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {(fields.data?.sourceApps ?? []).map((a) => (
              <label
                key={a.key}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-[10px] border p-4 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                  app === a.key ? "border-primary bg-primary-50" : "hover:bg-surface-2",
                )}
              >
                <input
                  type="radio"
                  name="source-app"
                  value={a.key}
                  checked={app === a.key}
                  onChange={() => {
                    setApp(a.key);
                    setPresetId(NO_PRESET);
                  }}
                  className="sr-only"
                />
                <FileSpreadsheet className="size-6 shrink-0 text-primary" aria-hidden />
                <span className="grid gap-0.5">
                  <span className="text-sm font-semibold text-text-900">{a.name}</span>
                  <span className="text-[13px] text-text-500">{t(`appHint_${a.key}`)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {ownPresets.length > 0 ? (
          <div className="grid gap-1.5 sm:max-w-sm">
            <Label htmlFor="import-preset">{t("preset")}</Label>
            <Select value={presetId} onValueChange={setPresetId}>
              <SelectTrigger id="import-preset" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PRESET}>{t("presetGuess")}</SelectItem>
                {ownPresets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="grid gap-2">
          <Label htmlFor="import-file">{t("file")}</Label>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={input}
              id="import-file"
              type="file"
              accept={IMPORT_ACCEPT}
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setProblem(f && f.size > MAX_IMPORT_BYTES ? t("fileTooBig") : null);
                setFile(f && f.size <= MAX_IMPORT_BYTES ? f : null);
              }}
            />
            <Button type="button" variant="secondary" onClick={() => input.current?.click()}>
              <Upload aria-hidden />
              {t("chooseFile")}
            </Button>
            <span className="text-sm text-text-700">{file ? file.name : t("noFile")}</span>
          </div>
          <p className="text-[13px] text-text-500">{t("fileHint")}</p>
        </div>

        {problem ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {problem}
          </p>
        ) : null}
        <div>
          <Button disabled={!app || !file} loading={upload.isPending} onClick={() => upload.mutate()}>
            {t("upload")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ImportHistory() {
  const t = useTranslations("migration");
  const tz = useTimeZone();
  const { set } = useUrlParams();
  const list = useQuery({
    queryKey: ["migration", "imports"],
    queryFn: () => unwrap(api.GET("/v1/migration/imports")),
    refetchInterval: (q) => (q.state.data?.items.some((j) => importWorking(j.status)) ? 3_000 : false),
  });
  if (!list.data || list.data.items.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("history")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {list.data.items.map((j) => (
            <li key={j.id}>
              <button
                type="button"
                onClick={() => set({ job: j.id })}
                className="flex w-full flex-wrap items-center justify-between gap-2 py-3 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate text-sm font-medium text-text-900">{j.fileName}</span>
                  <span className="text-[13px] text-text-500">
                    {j.sourceAppName} · {formatRelative(j.createdAt, tz)}
                  </span>
                </span>
                <StatusPill tone={IMPORT_TONE[j.status]}>{t(`status_${j.status}`)}</StatusPill>
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

const STEPS = ["upload", "mapping", "check", "import"] as const;

function Stepper({ step }: { step: 1 | 2 | 3 | 4 }) {
  const t = useTranslations("migration");
  return (
    <ol className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" aria-label={t("steps")}>
      {STEPS.map((s, i) => {
        const n = i + 1;
        const done = n < step;
        const current = n === step;
        return (
          <li key={s} className="flex items-center gap-2" aria-current={current ? "step" : undefined}>
            <span
              className={cn(
                "grid size-6 place-items-center rounded-full text-[12px] font-semibold",
                done && "bg-success text-white dark:text-canvas",
                current && "bg-primary text-primary-foreground",
                !done && !current && "bg-surface-2 text-text-500 ring-1 ring-border",
              )}
            >
              {done ? <Check className="size-3.5" aria-hidden /> : n}
            </span>
            <span className={cn(current ? "font-semibold text-text-900" : "text-text-700")}>{t(`step_${s}`)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ImportJobPanel({ id }: { id: string }) {
  const t = useTranslations("migration");
  const { set } = useUrlParams();
  const fields = useFields();
  const job = useQuery({
    queryKey: ["migration", "imports", id],
    queryFn: () => unwrap(api.GET("/v1/migration/imports/{id}", { params: { path: { id } } })),
    refetchInterval: (q) => (q.state.data && importWorking(q.state.data.status) ? 2_000 : false),
  });
  return (
    <div className="grid gap-4">
      <Button variant="ghost" size="sm" className="justify-self-start -ml-2" onClick={() => set({ job: null })}>
        <ArrowLeft aria-hidden />
        {t("backToImports")}
      </Button>
      {job.isPending || fields.isPending ? (
        <Skeleton className="h-64" />
      ) : job.isError ? (
        <Card>
          <ErrorState error={job.error} onRetry={() => job.refetch()} />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-0.5">
              <h2 className="text-lg font-semibold text-text-900">{job.data.fileName}</h2>
              <span className="text-[13px] text-text-500">
                {job.data.sourceAppName} · {t("rowCount", { count: job.data.stats.rows ?? 0 })}
              </span>
            </div>
            <StatusPill tone={IMPORT_TONE[job.data.status]}>{t(`status_${job.data.status}`)}</StatusPill>
          </div>
          <Stepper step={importStep(job.data.status)} />
          <JobBody job={job.data} fields={fields.data?.fields ?? []} />
        </>
      )}
    </div>
  );
}

function JobBody({ job, fields }: { job: ImportJob; fields: ImportField[] }) {
  const t = useTranslations("migration");
  const { set } = useUrlParams();
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["migration", "imports"] });
  const reopen = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/v1/migration/imports/{id}/mapping", {
          params: { path: { id: job.id } },
          body: mappingBody(job.mapping ?? { headerRow: 1, fields: {}, weightUnit: "g", dimensionUnit: "cm" }, ""),
        }),
      ),
    onSuccess: refresh,
  });
  const run = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/migration/imports/{id}/import", { params: { path: { id: job.id } } })),
    onSuccess: refresh,
  });

  if (job.status === "uploaded") return <MappingEditor job={job} fields={fields} />;
  if (importWorking(job.status)) {
    return (
      <Card>
        <CardContent>
          <p className="text-sm text-text-700" aria-live="polite">
            {t(job.status === "validating" ? "validating" : "importing", { count: job.stats.rows ?? 0 })}
          </p>
        </CardContent>
      </Card>
    );
  }
  if (job.status === "validated" || job.status === "imported") {
    const s = job.stats;
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t(job.status === "validated" ? "validatedTitle" : "importedTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <dl className="grid gap-3 sm:grid-cols-3">
            <Stat
              label={t("statProducts")}
              value={t("createdUpdated", { created: s.products?.created ?? 0, updated: s.products?.updated ?? 0 })}
            />
            <Stat
              label={t("statVariants")}
              value={t("createdUpdated", { created: s.variants?.created ?? 0, updated: s.variants?.updated ?? 0 })}
            />
            <Stat
              label={t("statStock")}
              value={t("stockSet", {
                set: s.stock?.set ?? 0,
                skipped: (s.stock?.skipped ?? 0) + (s.stock?.confirmed ?? 0),
              })}
            />
          </dl>
          <p className="text-[13px] text-text-500">
            {t(job.status === "validated" ? "validatedBody" : "importedBody")}
          </p>
          {run.isError ? (
            <p role="alert" className="text-sm text-danger">
              {errorMessage(run.error)}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {job.status === "validated" ? (
              <>
                <Button loading={run.isPending} onClick={() => run.mutate()}>
                  {t("importNow")}
                </Button>
                <Button variant="secondary" loading={reopen.isPending} onClick={() => reopen.mutate()}>
                  {t("changeMapping")}
                </Button>
              </>
            ) : (
              <>
                <Button asChild>
                  <Link href="/produk">{t("seeProducts")}</Link>
                </Button>
                <Button asChild variant="secondary">
                  <Link href="/stok">{t("seeStock")}</Link>
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }
  // invalid or failed
  return (
    <div className="grid gap-4">
      {job.error ? <p className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">{job.error}</p> : null}
      {job.status === "invalid" ? <RowErrors job={job} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => set({ job: null })}>
          <Upload aria-hidden />
          {t("uploadAgain")}
        </Button>
        <Button variant="secondary" loading={reopen.isPending} onClick={() => reopen.mutate()}>
          {t("changeMapping")}
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-lg bg-surface-2 p-3">
      <dt className="text-[13px] text-text-500">{label}</dt>
      <dd className="text-sm font-semibold text-text-900">{value}</dd>
    </div>
  );
}

function RowErrors({ job }: { job: ImportJob }) {
  const t = useTranslations("migration");
  const tCommon = useTranslations("common");
  const errors = useInfiniteQuery({
    queryKey: ["migration", "imports", job.id, "errors"],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/migration/imports/{id}/errors", {
          params: { path: { id: job.id }, query: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = errors.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t("errorsTitle", { count: job.stats.errors ?? rows.length, rows: job.stats.errorRows ?? 0 })}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-text-700">{t("errorsBody")}</p>
        <Button asChild variant="secondary" className="justify-self-start">
          <a href={`/v1/migration/imports/${job.id}/errors/export`} download>
            <Download aria-hidden />
            {t("errorsDownload")}
          </a>
        </Button>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-surface-2">
              <TableRow>
                <TableHead className="w-20 text-right">{t("colRow")}</TableHead>
                <TableHead>{t("colField")}</TableHead>
                <TableHead>{t("colProblem")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="tabular text-right">{formatNumber(e.rowNumber)}</TableCell>
                  <TableCell className="text-text-700">{e.fieldLabel ?? "—"}</TableCell>
                  <TableCell>{e.message}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {errors.hasNextPage ? (
          <Button
            variant="secondary"
            className="justify-self-center"
            loading={errors.isFetchingNextPage}
            onClick={() => errors.fetchNextPage()}
          >
            {tCommon("loadMore")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Which column holds which OmniSeller field (L46 step 2): the api's guess from the header names, checked by
 * the seller against the first rows of the file. Required fields must be mapped before the file is checked.
 */
function MappingEditor({ job, fields }: { job: ImportJob; fields: ImportField[] }) {
  const t = useTranslations("migration");
  const queryClient = useQueryClient();
  const [m, setM] = useState<Mapping>(
    job.mapping ?? { headerRow: 1, fields: {}, weightUnit: "g", dimensionUnit: "cm" },
  );
  const [headerRow, setHeaderRow] = useState(String(m.headerRow));
  const [presetName, setPresetName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const missing = missingRequired(fields, m.fields);
  const shared = new Set(sharedColumns(m.fields));
  const unitWeight = fields.some((f) => f.unit === "weight" && m.fields[f.key] !== undefined);
  const unitDimension = fields.some((f) => f.unit === "dimension" && m.fields[f.key] !== undefined);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["migration", "imports"] });

  const save = useMutation({
    mutationFn: (body: Mapping) =>
      unwrap(
        api.PUT("/v1/migration/imports/{id}/mapping", {
          params: { path: { id: job.id } },
          body: mappingBody(body, presetName),
        }),
      ),
  });
  const check = useMutation({
    mutationFn: async () => {
      await save.mutateAsync(m);
      return unwrap(api.POST("/v1/migration/imports/{id}/validate", { params: { path: { id: job.id } } }));
    },
    onSuccess: refresh,
    onError: (e) => setProblem(errorMessage(e)),
  });
  const reread = useMutation({
    mutationFn: (row: number) => save.mutateAsync({ ...m, headerRow: row }),
    onSuccess: refresh,
    onError: (e) => setProblem(errorMessage(e)),
  });
  const setField = (key: string, column: string) =>
    setM((x) => {
      const next = { ...x.fields };
      if (column === UNUSED) delete next[key];
      else next[key] = Number(column);
      return { ...x, fields: next };
    });
  const row = Number(headerRow);
  const rowValid = Number.isInteger(row) && row >= 1 && row <= MAX_HEADER_ROW;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("mappingTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-text-700">{t("mappingBody")}</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="header-row">{t("headerRow")}</Label>
              <Input
                id="header-row"
                value={headerRow}
                inputMode="numeric"
                className="w-24"
                aria-invalid={!rowValid || undefined}
                onChange={(e) => setHeaderRow(e.target.value)}
              />
            </div>
            <Button
              variant="secondary"
              disabled={!rowValid || row === job.mapping?.headerRow}
              loading={reread.isPending}
              onClick={() => reread.mutate(row)}
            >
              {t("rereadHeader")}
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => {
              const value = m.fields[f.key];
              const id = `map-${f.key}`;
              return (
                <div key={f.key} className="grid gap-1.5">
                  <Label htmlFor={id} className="text-sm font-medium text-text-700">
                    {f.label}
                    {f.required ? <span className="text-danger"> *</span> : null}
                  </Label>
                  <Select
                    value={value === undefined ? UNUSED : String(value)}
                    onValueChange={(v) => setField(f.key, v)}
                  >
                    <SelectTrigger
                      id={id}
                      className="w-full"
                      aria-invalid={(f.required && value === undefined) || undefined}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNUSED}>{t("unused")}</SelectItem>
                      {job.columns.map((_, i) => (
                        <SelectItem key={columnLabel(job.columns, i)} value={String(i)}>
                          {columnLabel(job.columns, i)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {value !== undefined && shared.has(value) ? (
                    <p className="text-[13px] text-warning">{t("sharedColumn")}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
          {unitWeight || unitDimension ? (
            <div className="flex flex-wrap gap-6">
              {unitWeight ? (
                <div className="grid gap-1.5">
                  <span className="text-sm font-medium text-text-700">{t("weightUnit")}</span>
                  <Segmented
                    label={t("weightUnit")}
                    value={m.weightUnit}
                    onChange={(weightUnit) => setM((x) => ({ ...x, weightUnit }))}
                    options={[
                      { value: "g", label: t("unitGram") },
                      { value: "kg", label: t("unitKilogram") },
                    ]}
                  />
                </div>
              ) : null}
              {unitDimension ? (
                <div className="grid gap-1.5">
                  <span className="text-sm font-medium text-text-700">{t("dimensionUnit")}</span>
                  <Segmented
                    label={t("dimensionUnit")}
                    value={m.dimensionUnit}
                    onChange={(dimensionUnit) => setM((x) => ({ ...x, dimensionUnit }))}
                    options={[
                      { value: "cm", label: "cm" },
                      { value: "mm", label: "mm" },
                    ]}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("previewTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-[13px] text-text-500">{t("previewBody")}</p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-surface-2">
                <TableRow>
                  {job.columns.map((_, i) => {
                    const used = fields.filter((f) => m.fields[f.key] === i);
                    return (
                      <TableHead
                        key={columnLabel(job.columns, i)}
                        className={cn("h-auto py-2 align-top", used.length > 0 && "bg-primary-50")}
                      >
                        <span className="grid gap-0.5">
                          <span className="whitespace-nowrap text-text-900">{columnLabel(job.columns, i)}</span>
                          <span
                            className={cn(
                              "text-[12px] font-normal",
                              used.length > 0 ? "text-primary-600" : "text-text-500",
                            )}
                          >
                            {used.length > 0 ? `→ ${used.map((f) => f.label).join(", ")}` : t("unused")}
                          </span>
                        </span>
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {job.preview.slice(0, 5).map((r, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no id; their order is the file's
                  <TableRow key={i}>
                    {job.columns.map((_, c) => (
                      <TableCell key={columnLabel(job.columns, c)} className="max-w-48 truncate">
                        {r[c] ?? ""}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-3">
          <div className="grid gap-1.5 sm:max-w-sm">
            <Label htmlFor="preset-name">{t("savePreset")}</Label>
            <Input
              id="preset-name"
              value={presetName}
              placeholder={t("savePresetPlaceholder")}
              onChange={(e) => setPresetName(e.target.value)}
            />
          </div>
          {missing.length > 0 ? (
            <p className="text-sm text-danger">
              {t("missingFields", { fields: missing.map((f) => f.label).join(", ") })}
            </p>
          ) : null}
          {problem ? (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
              {problem}
            </p>
          ) : null}
          <div>
            <Button disabled={missing.length > 0} loading={check.isPending} onClick={() => check.mutate()}>
              {t("checkFile")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
