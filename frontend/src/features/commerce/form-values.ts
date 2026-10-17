import { zonedToIso } from "@/features/orders/manual-order-meta";
import { formatDate, formatDateTime } from "@/lib/format";
import { parseTemporalText } from "@/lib/localized-input";
import type { CommerceField, CommerceInput } from "./contracts";

export type DraftValue = string | boolean | DraftValue[] | { [key: string]: DraftValue };
export type DraftObject = { [key: string]: DraftValue };
export type FormIssue = {
  path: string;
  label: string;
  reason:
    | "required"
    | "integer"
    | "minimum"
    | "maximum"
    | "option"
    | "incomplete"
    | "number"
    | "maxLength"
    | "datetime";
};
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const isObject = (value: unknown): value is DraftObject =>
  !!value && typeof value === "object" && !Array.isArray(value);
export const asObject = (value: DraftValue | undefined): DraftObject => (isObject(value) ? value : {});

function parseValue(
  field: CommerceField,
  value: DraftValue | undefined,
  path: string,
  issues: FormIssue[],
  timeZone: string,
): JsonValue | undefined {
  const add = (reason: FormIssue["reason"]) => issues.push({ path, label: field.label, reason });
  if (value === undefined || value === "") {
    if (field.allowEmpty && field.type === "string" && (field.required || value === "")) return "";
    if (field.required) add("required");
    return undefined;
  }
  if (field.type === "object") {
    const children = field.children ?? [];
    if (!children.length) {
      add("incomplete");
      return undefined;
    }
    return parseObject(children, asObject(value), path, issues, timeZone);
  }
  if (field.type === "array") {
    const values = Array.isArray(value) ? value : [];
    if (field.required && values.length === 0) add("required");
    if (field.minimum !== undefined && values.length < field.minimum) add("minimum");
    if (field.maximum !== undefined && values.length > field.maximum) add("maximum");
    return values.flatMap((entry, index) => {
      if (field.children?.length)
        return [parseObject(field.children, asObject(entry), `${path}.${index}`, issues, timeZone)];
      const item = {
        ...field,
        type: field.itemType ?? "string",
        required: true,
        children: undefined,
        minimum: undefined,
        maximum: undefined,
      } as CommerceField;
      const parsed = parseValue(item, entry, `${path}.${index}`, issues, timeZone);
      return parsed === undefined ? [] : [parsed];
    });
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") add("option");
    return typeof value === "boolean" ? value : undefined;
  }
  if (field.type === "file") {
    const file = asObject(value);
    if (typeof file.fileId !== "string" || !file.fileId) {
      add("required");
      return undefined;
    }
    return file.fileId;
  }
  let text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (field.required) add("required");
    return undefined;
  }
  if (field.format === "datetime" && (field.type === "integer" || field.type === "number")) {
    const local = parseTemporalText(text, "datetime-local");
    if (!local) {
      add("datetime");
      return undefined;
    }
    const epochMilliseconds = Date.parse(zonedToIso(local, timeZone));
    text = String(field.timestampUnit === "milliseconds" ? epochMilliseconds : Math.floor(epochMilliseconds / 1000));
  }
  if (field.type === "integer" || field.type === "number") {
    if (
      !(field.type === "integer"
        ? /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text))
        : /^-?\d+(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text)))
    ) {
      add(field.type);
      return undefined;
    }
    const number = Number(text);
    if (field.minimum !== undefined && number < field.minimum) add("minimum");
    if (field.maximum !== undefined && number > field.maximum) add("maximum");
    return number;
  }
  if (field.type === "enum" && !field.options?.includes(text)) add("option");
  if (field.maxLength !== undefined && text.length > field.maxLength) add("maxLength");
  return text;
}

function parseObject(
  fields: readonly CommerceField[],
  draft: DraftObject,
  prefix: string,
  issues: FormIssue[],
  timeZone: string,
): { [key: string]: JsonValue } {
  const result: { [key: string]: JsonValue } = {};
  for (const field of fields) {
    const value = parseValue(
      field,
      draft[field.name],
      prefix ? `${prefix}.${field.name}` : field.name,
      issues,
      timeZone,
    );
    if (value !== undefined) result[field.name] = value;
  }
  return result;
}

/** Only fields from the server's verified descriptor enter a request. Optional blank values are omitted. */
export function commerceInput(
  fields: readonly CommerceField[],
  draft: DraftObject,
  timeZone = "Asia/Jakarta",
): { input: CommerceInput; issues: FormIssue[] } {
  const issues: FormIssue[] = [];
  const input: Record<string, Record<string, JsonValue>> = {};
  for (const field of fields) {
    const [location, ...segments] = field.name.split(".");
    if (!["body", "path", "query"].includes(location ?? "") || segments.length !== 1 || !segments[0]) {
      issues.push({ path: field.name, label: field.label, reason: "incomplete" });
      continue;
    }
    const value = parseValue(field, draft[field.name], field.name, issues, timeZone);
    if (value !== undefined && location) {
      input[location] ??= {};
      input[location][segments[0]] = value;
    }
  }
  return { input, issues };
}

export function fieldsIssues(
  fields: readonly CommerceField[],
  draft: DraftObject,
  timeZone = "Asia/Jakarta",
): FormIssue[] {
  const issues: FormIssue[] = [];
  parseObject(fields, draft, "", issues, timeZone);
  return issues;
}

/** A review uses field labels and filenames; internal upload IDs stay out of the product flow. */
export function commerceReview(
  fields: readonly CommerceField[],
  draft: DraftObject,
  timeZone: string,
): Record<string, unknown> {
  const review: Record<string, unknown> = {};
  for (const field of fields) {
    const value = draft[field.name];
    if (value === undefined || value === "") continue;
    if (field.type === "file") review[field.label] = asObject(value).filename;
    else if (field.type === "object")
      review[field.label] = commerceReview(field.children ?? [], asObject(value), timeZone);
    else if (field.type === "array" && field.children?.length && Array.isArray(value))
      review[field.label] = value.map((row) => commerceReview(field.children ?? [], asObject(row), timeZone));
    else if (field.format === "money" && typeof value === "string")
      review[field.label] = { currency: "IDR", amount: value };
    else if (field.format === "datetime" && typeof value === "string" && parseTemporalText(value, "datetime-local"))
      review[field.label] = formatDateTime(zonedToIso(value, timeZone), timeZone);
    else if (field.format === "date" && typeof value === "string" && parseTemporalText(value, "date"))
      review[field.label] = formatDate(zonedToIso(value, timeZone), timeZone);
    else review[field.label] = value;
  }
  return review;
}
