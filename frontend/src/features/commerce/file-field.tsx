"use client";

import { useMutation } from "@tanstack/react-query";
import { FileCheck, LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatNumber } from "@/lib/format";
import type { CommerceField } from "./contracts";
import { asObject, type DraftValue } from "./form-values";

export type CommerceUploadContext = { operationId: string; principalId: string };

export function CommerceFileField({
  id,
  field,
  value,
  onChange,
  context,
  disabled,
}: {
  id: string;
  field: CommerceField;
  value: DraftValue | undefined;
  onChange: (value: DraftValue | undefined) => void;
  context?: CommerceUploadContext;
  disabled: boolean;
}) {
  const t = useTranslations("commerce");
  const helpId = useId();
  const [error, setError] = useState<string>();
  const defaultMaxBytes = field.maxBytes ?? 10_000_000;
  const maxBytes = Math.max(defaultMaxBytes, ...Object.values(field.maxBytesByMime ?? {}));
  const saved = asObject(value);
  const upload = useMutation({
    mutationKey: ["commerce", "upload", context?.operationId, context?.principalId],
    mutationFn: async (file: File) => {
      if (!context) throw new Error(t("uploadUnavailable"));
      const form = new FormData();
      form.append("operationId", context.operationId);
      form.append("principalId", context.principalId);
      form.append("file", file);
      return unwrap(
        api.POST("/v1/commerce/files", {
          body: { ...context, file: file.name },
          bodySerializer: () => form,
        }),
      );
    },
    onSuccess: (result) => {
      setError(undefined);
      onChange({ fileId: result.fileId, filename: result.filename });
    },
  });
  return (
    <div className="grid min-w-0 gap-2">
      <Input
        id={id}
        type="file"
        accept={field.accept?.join(",")}
        disabled={disabled || upload.isPending || !context}
        aria-describedby={helpId}
        aria-required={field.required}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          onChange({ fileId: "", filename: file.name });
          setError(undefined);
          const typeLimit = field.maxBytesByMime?.[file.type] ?? defaultMaxBytes;
          if (field.minBytes !== undefined && file.size < field.minBytes) {
            setError(t("fileMinSize", { size: formatNumber(field.minBytes) }));
            return;
          }
          if (file.size === 0 || file.size > typeLimit) {
            setError(t("fileSizeError", { size: formatNumber(typeLimit / 1_000_000) }));
            return;
          }
          if (
            field.accept?.length &&
            file.type &&
            !field.accept.some((type) =>
              type.endsWith("/*") ? file.type.startsWith(type.slice(0, -1)) : type === file.type,
            )
          ) {
            setError(t("fileTypeError"));
            return;
          }
          upload.mutate(file);
        }}
      />
      <p id={helpId} className="text-xs text-text-500">
        {t("uploadHint", { size: formatNumber(maxBytes / 1_000_000) })}
      </p>
      {field.maxBytesByMime ? (
        <p className="text-xs text-text-500">
          {t("fileTypeLimits", {
            limits: Object.entries(field.maxBytesByMime)
              .map(([mime, bytes]) => `${mime.split("/").at(-1)?.toUpperCase()} ${formatNumber(bytes / 1_000_000)} MB`)
              .join(" · "),
          })}
        </p>
      ) : null}
      {upload.isPending ? (
        <p role="status" className="flex items-center gap-2 text-xs text-primary">
          <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
          {t("uploading")}
        </p>
      ) : typeof saved.filename === "string" && typeof saved.fileId === "string" && saved.fileId ? (
        <p className="flex min-w-0 items-center gap-2 text-xs text-success">
          <FileCheck className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{saved.filename}</span>
        </p>
      ) : null}
      {error || upload.isError ? (
        <p role="alert" className="text-xs text-danger">
          {error ?? errorMessage(upload.error)}
        </p>
      ) : null}
    </div>
  );
}
