"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarOff, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner } from "@/components/common/form";
import { EmptyState, ErrorState } from "@/components/common/page";
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
import { Skeleton } from "@/components/ui/skeleton";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { formatDate } from "@/lib/format";
import { useTimeZone } from "@/lib/session";
import { DAY_LONG, type Holiday } from "./courier-hours-meta";

export const holidaysQueryKey = ["courier-holidays"] as const;

/** "Jumat, 25 Des 2026": a holiday's date with its day. */
function holidayDate(date: string, timeZone: string): string {
  return `${DAY_LONG[new Date(`${date}T00:00:00Z`).getUTCDay()]}, ${formatDate(`${date}T12:00:00Z`, timeZone)}`;
}

/** Days couriers do not collect (all of them, or one), from 30 days back. */
export function HolidaysTab() {
  const t = useTranslations("courierHours");
  const tz = useTimeZone();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const holidays = useQuery({ queryKey: holidaysQueryKey, queryFn: () => unwrap(api.GET("/v1/courier-holidays")) });
  const remove = useMutation({
    mutationFn: (h: Holiday) => unwrap(api.DELETE("/v1/courier-holidays/{id}", { params: { path: { id: h.id } } })),
    onSuccess: (_, h) => {
      toast.success(t("holidayRemoved", { date: holidayDate(h.date, tz) }));
      void queryClient.invalidateQueries({ queryKey: holidaysQueryKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("tab_libur")}</h2>
        </CardTitle>
        <CardDescription>{t("holidaysBody")}</CardDescription>
        <CardAction>
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            {t("addHoliday")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {holidays.isPending ? (
          <Skeleton className="h-24" />
        ) : holidays.isError ? (
          <ErrorState error={holidays.error} onRetry={() => holidays.refetch()} />
        ) : holidays.data.items.length === 0 ? (
          <EmptyState icon={CalendarOff} title={t("noHolidaysTitle")} body={t("noHolidays")} />
        ) : (
          <ul aria-label={t("tab_libur")} className="divide-y rounded-lg border">
            {holidays.data.items.map((h) => (
              <li key={h.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="font-medium text-text-900">{holidayDate(h.date, tz)}</span>
                  <span className="text-[13px] text-text-500">
                    {h.courier ?? t("allCouriers")}
                    {h.note ? ` · ${h.note}` : ""}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("removeNamed", { name: holidayDate(h.date, tz) })}
                  loading={remove.isPending && remove.variables?.id === h.id}
                  onClick={() => remove.mutate(h)}
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>{t("holidayTitle")}</DialogTitle>
            <DialogDescription>{t("holidayDialogBody")}</DialogDescription>
          </DialogHeader>
          {adding ? (
            <HolidayForm
              onClose={() => setAdding(false)}
              onSaved={() => void queryClient.invalidateQueries({ queryKey: holidaysQueryKey })}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function HolidayForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("courierHours");
  const tz = useTimeZone();
  const [date, setDate] = useState("");
  const [scope, setScope] = useState<"all" | "one">("all");
  const [courier, setCourier] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Partial<Record<"date" | "courier" | "banner", string>>>({});
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/courier-holidays", {
          body: { date, courier: scope === "one" ? courier.trim() : null, note: note.trim() || null },
        }),
      ),
    onSuccess: (h) => {
      toast.success(t("holidaySaved", { date: holidayDate(h.date, tz) }));
      onSaved();
      onClose();
    },
    onError: (e) => {
      const issue = e instanceof ApiError ? e.errors[0] : undefined;
      setErrors(
        issue && (issue.path === "date" || issue.path === "courier")
          ? { [issue.path]: issue.message }
          : { banner: errorMessage(e) },
      );
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found: typeof errors = {};
    if (!date) found.date = t("problem_dateRequired");
    if (scope === "one" && !courier.trim()) found.courier = t("problem_courierRequired");
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate();
  };
  return (
    <form className="grid gap-4" noValidate onSubmit={submit}>
      <FormBanner message={errors.banner} />
      <Field id="holiday-date" label={t("date")} error={errors.date}>
        <Input
          type="date"
          className="w-48"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          {...fieldProps("holiday-date", errors.date)}
        />
      </Field>
      <Segmented
        label={t("holidayFor")}
        value={scope}
        onChange={setScope}
        options={[
          { value: "all", label: t("allCouriers") },
          { value: "one", label: t("oneCourier") },
        ]}
      />
      {scope === "one" ? (
        <Field id="holiday-courier" label={t("courier")} error={errors.courier}>
          <Input
            value={courier}
            onChange={(e) => setCourier(e.target.value)}
            {...fieldProps("holiday-courier", errors.courier)}
          />
        </Field>
      ) : null}
      <Field id="holiday-note" label={t("note")}>
        <Input
          value={note}
          maxLength={120}
          onChange={(e) => setNote(e.target.value)}
          {...fieldProps("holiday-note", undefined)}
        />
      </Field>
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
