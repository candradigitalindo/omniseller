"use client";

import { cn } from "cn";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ChangeEvent, type ComponentProps, useEffect, useId, useRef, useState } from "react";
import { parseTemporalText, type TemporalType, temporalText } from "@/lib/localized-input";
import { useTimeZone } from "@/lib/session";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
import { BaseInput } from "./input-base";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

/** Indonesian display and calendar/clock dialogs; values emitted to forms stay ISO dates or HH:mm. */
export function TemporalInput({
  type,
  value = "",
  onChange,
  onBlur,
  onKeyDown,
  className,
  ref,
  min,
  max,
  ...props
}: Omit<ComponentProps<"input">, "type"> & { type: TemporalType }) {
  const t = useTranslations("common");
  const timeZone = useTimeZone();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(temporalText(String(value), type));
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [yearText, setYearText] = useState(today.slice(0, 4));
  const [time, setTime] = useState("09.00");
  const id = useId();
  const isDate = type !== "time";
  const isTime = type !== "date";
  useEffect(() => {
    setText(temporalText(String(value), type));
  }, [value, type]);
  const outOfRange = (next: string) =>
    !!next && ((min !== undefined && next < String(min)) || (max !== undefined && next > String(max)));
  const send = (next: string, event?: ChangeEvent<HTMLInputElement>) => {
    const node = input.current;
    if (!node) return;
    onChange?.({
      ...event,
      target: { ...node, name: props.name ?? "", value: next },
      currentTarget: { ...node, value: next },
    } as ChangeEvent<HTMLInputElement>);
  };
  const commit = (nextText: string, event?: ChangeEvent<HTMLInputElement>, blurred = false) => {
    const parsed = parseTemporalText(nextText, type);
    const problem =
      parsed === null
        ? t(type === "time" ? "invalidTime" : "invalidDate")
        : outOfRange(parsed)
          ? t("dateOutOfRange")
          : "";
    input.current?.setCustomValidity(problem);
    if (blurred) setError(problem);
    else if (!problem) setError("");
    if (parsed !== null && !problem) send(parsed, event);
    else if (blurred) send(nextText, event);
    return !problem;
  };
  const begin = () => {
    const current = parseTemporalText(String(value), type);
    const date = current && isDate ? current.slice(0, 10) : today;
    setSelected(date);
    setMonth(date.slice(0, 7));
    setTime(current && isTime ? temporalText(type === "time" ? current : current.slice(11), "time") : "09.00");
    setOpen(true);
  };
  const title = t(type === "date" ? "chooseDate" : type === "time" ? "chooseTime" : "chooseDateTime");
  const parsedTime = parseTemporalText(time, "time");
  const chosen =
    type === "date" ? selected : type === "time" ? parsedTime : parsedTime ? `${selected}T${parsedTime}` : null;
  const [y = 2026, m = 1] = month.split("-").map(Number);
  useEffect(() => {
    setYearText(String(y).padStart(4, "0"));
  }, [y]);
  const first = new Date(`${month}-01T00:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const months = t.raw("months") as string[];
  const weekdays = t.raw("weekdays") as string[];
  const shiftMonth = (n: number) => {
    const next = new Date(Date.UTC(y, m - 1 + n, 1));
    if (next.getUTCFullYear() >= 100 && next.getUTCFullYear() <= 9998) setMonth(next.toISOString().slice(0, 7));
  };
  return (
    <>
      <div className="relative min-w-0">
        <BaseInput
          {...props}
          ref={(node) => {
            input.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          type="text"
          min={min}
          max={max}
          inputMode={isDate ? "text" : "numeric"}
          lang="id-ID"
          value={text}
          placeholder={
            props.placeholder ??
            t(type === "date" ? "datePlaceholder" : type === "time" ? "timePlaceholder" : "dateTimePlaceholder")
          }
          className={cn(className, "tabular pr-11")}
          aria-invalid={error ? true : props["aria-invalid"]}
          aria-describedby={
            [props["aria-describedby"], error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined
          }
          onChange={(e) => {
            setText(e.target.value);
            commit(e.target.value, e);
          }}
          onBlur={(e) => {
            commit(e.target.value, undefined, true);
            onBlur?.(e);
          }}
          onKeyDown={(e) => {
            onKeyDown?.(e);
            if (e.defaultPrevented) return;
            if (e.altKey && e.key === "ArrowDown") {
              e.preventDefault();
              begin();
            } else if (e.key === "Enter" && !commit(text, undefined, true)) e.preventDefault();
          }}
        />
        <button
          type="button"
          disabled={props.disabled || props.readOnly}
          onClick={begin}
          aria-label={title}
          aria-haspopup="dialog"
          className="absolute inset-y-1 right-1 grid w-9 place-items-center rounded-lg text-text-500 outline-none hover:bg-surface-2 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          {isDate ? <CalendarDays className="size-4" aria-hidden /> : <Clock3 className="size-4" aria-hidden />}
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="w-[calc(100%-2rem)] sm:max-w-[400px]"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{t(type === "time" ? "invalidTime" : "datePlaceholder")}</DialogDescription>
          </DialogHeader>
          {isDate ? (
            <div className="grid gap-3">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon-sm" aria-label={t("previousMonth")} onClick={() => shiftMonth(-1)}>
                  <ChevronLeft aria-hidden />
                </Button>
                <Select value={String(m)} onValueChange={(v) => setMonth(`${y}-${v.padStart(2, "0")}`)}>
                  <SelectTrigger aria-label={t("month")} className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {months.map((name, i) => (
                      <SelectItem key={name} value={String(i + 1)}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <BaseInput
                  aria-label={t("year")}
                  type="number"
                  min={100}
                  max={9998}
                  value={yearText}
                  className="h-10 w-22 text-center"
                  onChange={(e) => {
                    setYearText(e.target.value);
                    const year = Number(e.target.value);
                    if (e.target.value.length === 4 && year >= 100 && year <= 9998)
                      setMonth(`${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
                  }}
                />
                <Button variant="ghost" size="icon-sm" aria-label={t("nextMonth")} onClick={() => shiftMonth(1)}>
                  <ChevronRight aria-hidden />
                </Button>
              </div>
              <div className="grid grid-cols-7 gap-1">
                {weekdays.map((day) => (
                  <span key={day} className="py-2 text-center text-xs font-semibold text-text-500">
                    {day}
                  </span>
                ))}
                {Array.from({ length: offset }, (_, i) => (
                  <span key={`${month}-${weekdays[i]}`} />
                ))}
                {Array.from({ length }, (_, i) => {
                  const day = `${month}-${String(i + 1).padStart(2, "0")}`;
                  const disabled = !!(
                    (min !== undefined && day < String(min).slice(0, 10)) ||
                    (max !== undefined && day > String(max).slice(0, 10))
                  );
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-label={new Intl.DateTimeFormat("id-ID", {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                        timeZone: "UTC",
                      }).format(new Date(`${day}T00:00:00Z`))}
                      aria-pressed={selected === day}
                      aria-current={day === today ? "date" : undefined}
                      disabled={disabled}
                      className={cn(
                        "aspect-square rounded-xl text-sm outline-none transition-colors hover:bg-primary-50 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-25",
                        day === today && "font-bold ring-1 ring-inset ring-border",
                        selected === day && "bg-primary font-semibold text-white hover:bg-primary-700",
                      )}
                      onClick={() => setSelected(day)}
                    >
                      {i + 1}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {isTime ? (
            <label htmlFor={`${id}-time`} className="grid gap-1.5 text-sm font-medium">
              <span>{t("hour")}</span>
              <BaseInput
                id={`${id}-time`}
                inputMode="numeric"
                placeholder="14.30"
                value={time}
                onChange={(e) => {
                  const parsed = parseTemporalText(e.target.value, "time");
                  setTime(parsed ? temporalText(parsed, "time") : e.target.value);
                }}
                className="tabular text-center text-xl"
              />
            </label>
          ) : null}
          <p className="rounded-xl bg-surface-2 px-3 py-2 text-center text-sm font-medium text-text-700">
            {chosen ? temporalText(chosen, type) : t("invalidTime")}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              disabled={chosen === null || outOfRange(chosen) || (isDate && yearText !== String(y).padStart(4, "0"))}
              onClick={() => {
                if (chosen !== null) {
                  send(chosen);
                  setText(temporalText(chosen, type));
                  setError("");
                  input.current?.setCustomValidity("");
                  setOpen(false);
                }
              }}
            >
              {t("applyChoice")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
