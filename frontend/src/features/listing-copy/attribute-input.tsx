"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AttributeValue, RuleAttribute } from "./copy-meta";

const NONE = "__none";
const FILTER_FROM = 12;

/**
 * One category attribute as the marketplace takes it (backend 8.25): a value from its list, several of them,
 * typed text (with a unit when it has units), or a list value or typed text. `id` names the first control,
 * so the label above it points somewhere.
 */
export function AttributeInput({
  id,
  attribute: a,
  value,
  onChange,
  disabled,
  invalid,
}: {
  id: string;
  attribute: RuleAttribute;
  value: AttributeValue;
  onChange: (value: AttributeValue) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const t = useTranslations("listingCopy");
  const [filter, setFilter] = useState("");
  const multi = a.input === "multi_select" || a.input === "multi_select_or_text";
  const typed = a.input === "text" || a.input === "select_or_text" || a.input === "multi_select_or_text";
  const listed = a.input !== "text" && a.values.length > 0;
  const numeric = a.valueFormat === "integer" || a.valueFormat === "decimal";
  const invalidProps = invalid ? { "aria-invalid": true as const } : {};

  const textInput = (first: boolean) =>
    typed ? (
      <div className="flex gap-2">
        <Input
          id={first ? id : `${id}-text`}
          value={value.text}
          disabled={disabled}
          inputMode={numeric ? "decimal" : undefined}
          placeholder={listed ? (multi ? t("attributeOtherMany") : t("attributeOther")) : undefined}
          aria-label={first ? undefined : t("attributeTyped", { name: a.name })}
          onChange={(e) =>
            onChange({
              ...value,
              text: e.target.value,
              valueIds: multi || !e.target.value ? value.valueIds : [],
              // the unit shown is the unit saved: the first one until another is chosen
              unit: value.unit || (a.units[0] ?? ""),
            })
          }
          {...invalidProps}
        />
        {a.units.length > 0 ? (
          <Select
            value={value.unit || a.units[0]}
            onValueChange={(unit) => onChange({ ...value, unit })}
            disabled={disabled}
          >
            <SelectTrigger className="w-24" aria-label={t("unit")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {a.units.map((u) => (
                <SelectItem key={u} value={u}>
                  {u}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
    ) : null;

  if (!listed) return textInput(true);

  if (!multi) {
    return (
      <div className="grid gap-2">
        <Select
          value={value.valueIds[0] ?? NONE}
          disabled={disabled}
          onValueChange={(v) =>
            onChange({ ...value, valueIds: v === NONE ? [] : [v], text: v === NONE ? value.text : "" })
          }
        >
          <SelectTrigger id={id} className="w-full" {...invalidProps}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t("attributeNone")}</SelectItem>
            {a.values.map((v) => (
              <SelectItem key={v.valueId} value={v.valueId}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {textInput(false)}
      </div>
    );
  }

  const shown = filter.trim()
    ? a.values.filter((v) => v.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : a.values;
  const full = a.maxValues !== null && value.valueIds.length >= a.maxValues;
  return (
    <div className="grid gap-2">
      {a.values.length > FILTER_FROM ? (
        <Input
          id={id}
          value={filter}
          disabled={disabled}
          placeholder={t("attributeFilter")}
          onChange={(e) => setFilter(e.target.value)}
        />
      ) : null}
      <fieldset
        aria-labelledby={`${id}-label`}
        className="grid max-h-48 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2"
        {...(a.values.length > FILTER_FROM ? {} : { id })}
      >
        {shown.map((v) => {
          const checked = value.valueIds.includes(v.valueId);
          return (
            <Label key={v.valueId} className="flex cursor-pointer items-center gap-2 font-normal">
              <Checkbox
                checked={checked}
                disabled={disabled || (!checked && full)}
                onCheckedChange={(on) =>
                  onChange({
                    ...value,
                    valueIds: on ? [...value.valueIds, v.valueId] : value.valueIds.filter((x) => x !== v.valueId),
                  })
                }
              />
              <span className="text-sm text-text-900">{v.name}</span>
            </Label>
          );
        })}
      </fieldset>
      {a.maxValues !== null ? (
        <p className="text-[13px] text-text-500">{t("attributeMax", { count: a.maxValues })}</p>
      ) : null}
      {textInput(false)}
    </div>
  );
}
