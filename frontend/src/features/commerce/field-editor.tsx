"use client";

import { useIsMutating } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, CircleHelp, Layers3, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { zoneAbbreviation } from "@/lib/format";
import { useTimeZone } from "@/lib/session";
import type { CommerceField } from "./contracts";
import { CommerceFileField, type CommerceUploadContext } from "./file-field";
import { asObject, type DraftObject, type DraftValue, type FormIssue, fieldsIssues } from "./form-values";
import { useCommerceLabel } from "./labels";

export function CommerceFieldEditor({
  field,
  value,
  onChange,
  issue,
  disabled = false,
  uploadContext,
}: {
  field: CommerceField;
  value: DraftValue | undefined;
  onChange: (value: DraftValue | undefined) => void;
  issue?: FormIssue;
  disabled?: boolean;
  uploadContext?: CommerceUploadContext;
}) {
  const t = useTranslations("commerce");
  const label = useCommerceLabel();
  const id = useId();
  const timeZone = useTimeZone();
  const [editing, setEditing] = useState(false);
  const [help, setHelp] = useState(false);
  const compound = field.type === "array" || field.type === "object";
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <label htmlFor={id} className="line-clamp-2 text-sm font-medium text-text-900">
          {label(field.label)}
          {field.required ? (
            <span className="ml-1 text-danger" aria-hidden>
              *
            </span>
          ) : null}
        </label>
        {field.description ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-my-1 shrink-0"
            aria-label={t("fieldHelp", { field: label(field.label) })}
            onClick={() => setHelp(true)}
          >
            <CircleHelp aria-hidden />
          </Button>
        ) : null}
      </div>
      {field.type === "file" ? (
        <CommerceFileField
          id={id}
          field={field}
          value={value}
          onChange={onChange}
          context={uploadContext}
          disabled={disabled}
        />
      ) : compound ? (
        <Button
          id={id}
          type="button"
          variant="secondary"
          disabled={disabled}
          className="min-w-0 justify-start"
          onClick={() => setEditing(true)}
        >
          <Layers3 aria-hidden />
          <span className="truncate">
            {field.type === "array"
              ? t("editItems", { count: Array.isArray(value) ? value.length : 0 })
              : t(value ? "editDetails" : "addDetails")}
          </span>
        </Button>
      ) : field.type === "enum" || field.type === "boolean" ? (
        <Select
          value={typeof value === "boolean" ? String(value) : typeof value === "string" ? value : ""}
          onValueChange={(next) => onChange(field.type === "boolean" ? next === "true" : next)}
          disabled={disabled}
        >
          <SelectTrigger
            id={id}
            className="w-full min-w-0"
            aria-invalid={!!issue}
            aria-required={field.required}
            aria-describedby={issue ? `${id}-error` : undefined}
          >
            <SelectValue placeholder={t("chooseValue")} />
          </SelectTrigger>
          <SelectContent>
            {field.type === "boolean" ? (
              <>
                <SelectItem value="true">{t("yes")}</SelectItem>
                <SelectItem value="false">{t("no")}</SelectItem>
              </>
            ) : (
              field.options?.map((option) => (
                <SelectItem key={option} value={option}>
                  {label(option)}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          autoComplete="off"
          type={
            field.format === "date"
              ? "date"
              : field.format === "time"
                ? "time"
                : field.format === "datetime"
                  ? "datetime-local"
                  : undefined
          }
          currency={field.format === "money"}
          maxLength={field.maxLength}
          inputMode={field.type === "integer" ? "numeric" : field.type === "number" ? "decimal" : undefined}
          aria-invalid={!!issue}
          aria-required={field.required}
          aria-describedby={issue ? `${id}-error` : undefined}
        />
      )}
      {field.allowEmpty ? <p className="text-xs text-text-500">{t("emptyFirstPage")}</p> : null}
      {field.format === "datetime" ? (
        <p className="text-xs text-text-500">{t("timeZone", { zone: zoneAbbreviation(timeZone) })}</p>
      ) : null}
      {issue ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {t(`validation.${issue.reason}`)}
        </p>
      ) : null}
      {editing ? (
        <CompoundEditor
          field={field}
          value={value}
          onSave={(next) => {
            onChange(next);
            setEditing(false);
          }}
          onClose={() => setEditing(false)}
          uploadContext={uploadContext}
        />
      ) : null}
      {help ? (
        <Dialog open onOpenChange={setHelp}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="line-clamp-2 leading-snug">{label(field.label)}</DialogTitle>
              <DialogDescription className="max-h-64 overflow-y-auto whitespace-pre-line">
                {field.description}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setHelp(false)}>
                {t("close")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function CompoundEditor({
  field,
  value,
  onSave,
  onClose,
  uploadContext,
}: {
  field: CommerceField;
  value: DraftValue | undefined;
  onSave: (value: DraftValue) => void;
  onClose: () => void;
  uploadContext?: CommerceUploadContext;
}) {
  const t = useTranslations("commerce");
  const label = useCommerceLabel();
  const uploading =
    useIsMutating({ mutationKey: ["commerce", "upload", uploadContext?.operationId, uploadContext?.principalId] }) > 0;
  const timeZone = useTimeZone();
  const [draft, setDraft] = useState<DraftValue>(value ?? (field.type === "array" ? [] : {}));
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const array = field.type === "array";
  const rows = Array.isArray(draft) ? draft : [];
  const object = asObject(array ? rows[index] : draft);
  const children = field.children ?? [];
  const primitive = array && !children.length;
  const limit = field.maximum ?? 100;
  const itemField = {
    ...field,
    name: "item",
    label: t("itemValue"),
    type: field.itemType ?? "string",
    required: true,
    maximum: undefined,
    minimum: undefined,
    children: undefined,
  } as CommerceField;
  const childPage = children.slice(page * 2, page * 2 + 2);
  const updateObject = (next: DraftObject) => {
    setIssues([]);
    setDraft(array ? rows.map((row, rowIndex) => (rowIndex === index ? next : row)) : next);
  };
  const validate = () => {
    const allIssues = array
      ? rows.flatMap((row) =>
          primitive
            ? fieldsIssues([itemField], { item: row }, timeZone)
            : fieldsIssues(children, asObject(row), timeZone),
        )
      : fieldsIssues(children, object, timeZone);
    if (array && field.required && !rows.length)
      allIssues.push({ path: field.name, label: field.label, reason: "required" });
    if (array && field.minimum !== undefined && rows.length < field.minimum)
      allIssues.push({ path: field.name, label: field.label, reason: "minimum" });
    setIssues(allIssues);
    if (!allIssues.length) onSave(draft);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !uploading) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={!uploading}>
        <DialogHeader>
          <DialogTitle className="line-clamp-2 leading-snug">{label(field.label)}</DialogTitle>
          <DialogDescription>{array ? t("structuredListHint") : t("structuredObjectHint")}</DialogDescription>
        </DialogHeader>
        {array ? (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-surface-2 p-2">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={uploading || !rows.length || index === 0}
              aria-label={t("previousItem")}
              onClick={() => {
                setIndex(index - 1);
                setPage(0);
              }}
            >
              <ChevronLeft aria-hidden />
            </Button>
            <span className="text-sm">
              {rows.length ? t("itemPosition", { current: index + 1, count: rows.length }) : t("noItems")}
            </span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={uploading || !rows.length || index + 1 === rows.length}
              aria-label={t("nextItem")}
              onClick={() => {
                setIndex(index + 1);
                setPage(0);
              }}
            >
              <ChevronRight aria-hidden />
            </Button>
          </div>
        ) : null}
        {!array || rows.length ? (
          <div className="grid gap-3">
            {primitive ? (
              <CommerceFieldEditor
                field={itemField}
                disabled={uploading}
                uploadContext={uploadContext}
                value={rows[index]}
                onChange={(next) => {
                  setIssues([]);
                  setDraft(rows.map((row, rowIndex) => (rowIndex === index ? (next ?? "") : row)));
                }}
              />
            ) : (
              childPage.map((child) => (
                <CommerceFieldEditor
                  key={child.name}
                  field={child}
                  disabled={uploading}
                  uploadContext={uploadContext}
                  value={object[child.name]}
                  onChange={(next) => {
                    const updated = { ...object };
                    if (next === undefined) delete updated[child.name];
                    else updated[child.name] = next;
                    updateObject(updated);
                  }}
                  issue={issues.find((issue) => issue.path === child.name)}
                />
              ))
            )}
          </div>
        ) : null}
        {!primitive && children.length > 2 ? (
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={uploading || page === 0}
              onClick={() => setPage(page - 1)}
            >
              {t("previous")}
            </Button>
            <span className="text-xs text-text-500">
              {t("step", { current: page + 1, count: Math.ceil(children.length / 2) })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={uploading || (page + 1) * 2 >= children.length}
              onClick={() => setPage(page + 1)}
            >
              {t("next")}
            </Button>
          </div>
        ) : null}
        {array ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={uploading || rows.length >= limit}
              onClick={() => {
                setDraft([...rows, primitive ? "" : {}]);
                setIndex(rows.length);
                setPage(0);
                setIssues([]);
              }}
            >
              <Plus aria-hidden />
              {t("addItem")}
            </Button>
            {rows.length ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={uploading}
                onClick={() => {
                  setDraft(rows.filter((_, rowIndex) => rowIndex !== index));
                  setIndex(Math.max(0, index - 1));
                  setPage(0);
                  setIssues([]);
                }}
              >
                <Trash2 aria-hidden />
                {t("removeItem")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {issues.length ? (
          <p role="alert" className="line-clamp-2 text-sm text-danger">
            {t("reviewField", { field: label(issues[0]?.label ?? field.label) })}{" "}
            {t(`validation.${issues[0]?.reason ?? "required"}`)}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={uploading} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="button" disabled={uploading} onClick={validate}>
            {t("saveDetails")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
