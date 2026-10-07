"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner } from "@/components/common/form";
import { ErrorState } from "@/components/common/page";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatDate } from "@/lib/format";
import { useTimeZone } from "@/lib/session";
import {
  DAY_LONG,
  DAY_ORDER,
  DEFAULT_WEEK,
  type Period,
  type Week,
  weekProblem,
  weekSummary,
} from "./courier-hours-meta";

export const hoursQueryKey = ["operating-hours"] as const;

const day = (date: string, timeZone: string) => formatDate(`${date}T12:00:00Z`, timeZone);

/** The usual week and special periods (Ramadan, Lebaran) that replace it on their dates. */
export function HoursTab() {
  const t = useTranslations("courierHours");
  const tz = useTimeZone();
  const queryClient = useQueryClient();
  const hours = useQuery({ queryKey: hoursQueryKey, queryFn: () => unwrap(api.GET("/v1/operating-hours")) });
  const [editing, setEditing] = useState<Period | "new" | null>(null);
  const [removing, setRemoving] = useState<Period | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: hoursQueryKey });
  const removePeriod = useMutation({
    mutationFn: (p: Period) =>
      unwrap(api.DELETE("/v1/operating-hours/periods/{id}", { params: { path: { id: p.id } } })),
    onSuccess: (_, p) => {
      setRemoving(null);
      toast.success(t("periodRemoved", { name: p.name }));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (hours.isPending) return <Skeleton className="h-64" />;
  if (hours.isError) {
    return (
      <Card>
        <ErrorState error={hours.error} onRetry={() => hours.refetch()} />
      </Card>
    );
  }
  return (
    <div className="grid gap-4">
      <WeekCard week={hours.data.week?.schedule ?? null} onSaved={refresh} />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("periodsTitle")}</h2>
          </CardTitle>
          <CardDescription>{t("periodsBody")}</CardDescription>
          <CardAction>
            <Button variant="secondary" onClick={() => setEditing("new")}>
              <Plus aria-hidden />
              {t("addPeriod")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {hours.data.periods.length === 0 ? (
            <p className="text-sm text-text-500">{t("noPeriods")}</p>
          ) : (
            <ul aria-label={t("periodsTitle")} className="divide-y rounded-lg border">
              {hours.data.periods.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="font-medium text-text-900">{p.name}</span>
                    <span className="text-[13px] text-text-500">
                      {t("periodDates", { from: day(p.from, tz), to: day(p.to, tz) })} ·{" "}
                      {weekSummary(p.schedule, t("closedAll"))}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("editNamed", { name: p.name })}
                    onClick={() => setEditing(p)}
                  >
                    <Pencil aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("removeNamed", { name: p.name })}
                    onClick={() => setRemoving(p)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Dialog open={editing !== null} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>
              {editing && editing !== "new" ? t("periodTitleEdit", { name: editing.name }) : t("periodTitleAdd")}
            </DialogTitle>
            <DialogDescription>{t("periodDialogBody")}</DialogDescription>
          </DialogHeader>
          {editing ? (
            <PeriodForm
              key={editing === "new" ? "new" : editing.id}
              period={editing === "new" ? null : editing}
              baseWeek={hours.data.week?.schedule ?? DEFAULT_WEEK}
              onClose={() => setEditing(null)}
              onSaved={refresh}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={removing !== null} onOpenChange={(v) => !v && setRemoving(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("removePeriodTitle", { name: removing?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("removePeriodBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={removePeriod.isPending}
              onClick={() => removing && removePeriod.mutate(removing)}
            >
              {t("remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WeekCard({ week, onSaved }: { week: Week | null; onSaved: () => void }) {
  const t = useTranslations("courierHours");
  const [draft, setDraft] = useState<Week | null>(week);
  const [problem, setProblem] = useState<string | undefined>();
  const save = useMutation({
    mutationFn: (schedule: Week) => unwrap(api.PUT("/v1/operating-hours/week", { body: { schedule } })),
    onSuccess: (w) => {
      setDraft(w.schedule);
      toast.success(t("weekSaved"));
      onSaved();
    },
    onError: (e) => setProblem(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/operating-hours/week")),
    onSuccess: () => {
      setDraft(null);
      toast.success(t("weekRemoved"));
      onSaved();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const p = weekProblem(draft);
    if (p) return setProblem(t(`problem_${p.key}`, { day: DAY_LONG[p.day] ?? "" }));
    setProblem(undefined);
    save.mutate(draft);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("weekTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("weekBody")}</CardDescription>
      </CardHeader>
      <CardContent>
        {draft ? (
          <form className="grid gap-4" noValidate onSubmit={submit}>
            <WeekEditor
              id="week"
              week={draft}
              onChange={(w) => {
                setDraft(w);
                setProblem(undefined);
              }}
            />
            <FormBanner message={problem} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={save.isPending}>
                {t("saveWeek")}
              </Button>
              {week ? (
                <Button type="button" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>
                  {t("removeWeek")}
                </Button>
              ) : (
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                  {t("cancel")}
                </Button>
              )}
            </div>
          </form>
        ) : (
          <div className="grid justify-items-start gap-3">
            <p className="text-sm text-text-500">{t("weekNotSet")}</p>
            <Button variant="secondary" onClick={() => setDraft(DEFAULT_WEEK)}>
              {t("setWeek")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Seven rows from Monday: open or closed, and the hours of an open day. */
function WeekEditor({ id, week, onChange }: { id: string; week: Week; onChange: (week: Week) => void }) {
  const t = useTranslations("courierHours");
  const setDay = (d: number, hours: Week[number]) => onChange(week.map((h, i) => (i === d ? hours : h)));
  return (
    <ul aria-label={t("weekLabel")} className="divide-y rounded-lg border">
      {DAY_ORDER.map((d) => {
        const h = week[d] ?? null;
        return (
          <li key={d} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
            <span className="w-20 text-sm font-medium text-text-900">{DAY_LONG[d]}</span>
            <span className="flex w-24 items-center gap-2 text-sm text-text-700">
              <Switch
                id={`${id}-open-${d}`}
                checked={h !== null}
                onCheckedChange={(v) => setDay(d, v ? { open: "08:00", close: "17:00" } : null)}
                aria-label={t("openOn", { day: DAY_LONG[d] })}
              />
              {h ? t("open") : t("closed")}
            </span>
            {h ? (
              <span className="flex items-center gap-2">
                <Input
                  type="time"
                  className="h-9 w-28"
                  value={h.open}
                  aria-label={t("openAt", { day: DAY_LONG[d] })}
                  onChange={(e) => setDay(d, { ...h, open: e.target.value })}
                />
                <span aria-hidden className="text-text-500">
                  –
                </span>
                <Input
                  type="time"
                  className="h-9 w-28"
                  value={h.close}
                  aria-label={t("closeAt", { day: DAY_LONG[d] })}
                  onChange={(e) => setDay(d, { ...h, close: e.target.value })}
                />
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function PeriodForm({
  period,
  baseWeek,
  onClose,
  onSaved,
}: {
  period: Period | null;
  baseWeek: Week;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("courierHours");
  const [name, setName] = useState(period?.name ?? "");
  const [from, setFrom] = useState(period?.from ?? "");
  const [to, setTo] = useState(period?.to ?? "");
  const [week, setWeek] = useState<Week>(period?.schedule ?? baseWeek);
  const [errors, setErrors] = useState<Partial<Record<"name" | "dates" | "week" | "banner", string>>>({});
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), from, to, schedule: week };
      return period
        ? unwrap(api.PATCH("/v1/operating-hours/periods/{id}", { params: { path: { id: period.id } }, body }))
        : unwrap(api.POST("/v1/operating-hours/periods", { body }));
    },
    onSuccess: (p) => {
      toast.success(t("periodSaved", { name: p.name }));
      onSaved();
      onClose();
    },
    onError: (e) => setErrors({ banner: errorMessage(e) }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found: typeof errors = {};
    if (!name.trim()) found.name = t("problem_nameRequired");
    if (!from || !to) found.dates = t("problem_datesRequired");
    else if (to < from) found.dates = t("problem_datesOrder");
    const p = weekProblem(week);
    if (p) found.week = t(`problem_${p.key}`, { day: DAY_LONG[p.day] ?? "" });
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate();
  };
  return (
    <form className="grid gap-4" noValidate onSubmit={submit}>
      <FormBanner message={errors.banner} />
      <Field id="period-name" label={t("periodName")} error={errors.name}>
        <Input
          value={name}
          maxLength={60}
          placeholder="Ramadan 1448 H"
          onChange={(e) => setName(e.target.value)}
          {...fieldProps("period-name", errors.name)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="period-from" label={t("from")} error={errors.dates}>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            {...fieldProps("period-from", errors.dates)}
          />
        </Field>
        <Field id="period-to" label={t("to")}>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            {...fieldProps("period-to", errors.dates)}
          />
        </Field>
      </div>
      <WeekEditor id="period" week={week} onChange={setWeek} />
      <FormBanner message={errors.week} />
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
