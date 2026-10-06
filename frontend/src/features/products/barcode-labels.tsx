"use client";

import { useMutation } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormBanner } from "@/components/common/form";
import { Segmented } from "@/components/common/segmented";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DocumentResult, PrintSettingsPanel, useDocument, usePrintSettings } from "@/features/shipping/print-target";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { LABEL_FORMATS, type LabelFormat, labelItems, labelProblems } from "./barcode-meta";

export type LabelVariant = { id: string; sku: string; name: string; barcode: string | null };
type LabelsBody = components["schemas"]["RequestBarcodeLabelsDto"];

/**
 * "Cetak label barcode" (FR-PRD-12): labels for the product's variants, with how many of each, on label stock
 * or A4 sheets, to this station's print agent or as a PDF. A variant without a barcode gets its SKU.
 */
export function BarcodeLabelsDialog({
  open,
  variants,
  onClose,
}: {
  open: boolean;
  variants: LabelVariant[];
  onClose: () => void;
}) {
  const t = useTranslations("barcodeLabels");
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>
        {open ? <LabelsForm variants={variants} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function LabelsForm({ variants, onClose }: { variants: LabelVariant[]; onClose: () => void }) {
  const t = useTranslations("barcodeLabels");
  const tCommon = useTranslations("common");
  const ids = variants.map((v) => v.id);
  const [copies, setCopies] = useState<Record<string, string>>(() => Object.fromEntries(ids.map((id) => [id, "1"])));
  const [format, setFormat] = useState<LabelFormat>("label_50x30");
  const [settings, setSettings] = usePrintSettings();
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | undefined>();
  const document = useDocument(documentId);
  const problems = labelProblems(ids, copies);
  // the body is made when the form is sent, from what the form shows then
  const make = useMutation({
    mutationFn: (body: LabelsBody) => unwrap(api.POST("/v1/documents/barcode-labels", { body })),
    onSuccess: (d) => setDocumentId(d.id),
    onError: (error) => setBanner(errorMessage(error)),
  });
  const blocked = problems.invalid.length > 0 || problems.tooMany || problems.total === 0;

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setBanner(undefined);
        if (blocked) return;
        make.mutate({
          items: labelItems(ids, copies),
          format,
          ...(settings.deviceId ? { print: { deviceId: settings.deviceId, copies: 1 } } : {}),
        });
      }}
    >
      <FormBanner message={banner} />
      <div className="max-h-72 overflow-y-auto rounded-lg border">
        <Table>
          <TableHeader className="bg-surface-2">
            <TableRow>
              <TableHead>{t("colVariant")}</TableHead>
              <TableHead>{t("colCode")}</TableHead>
              <TableHead className="w-28 text-right">{t("colCopies")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {variants.map((v) => {
              const bad = problems.invalid.includes(v.id);
              return (
                <TableRow key={v.id}>
                  <TableCell className="whitespace-normal">
                    <span className="grid">
                      <span className="font-mono text-sm text-text-900">{v.sku}</span>
                      <span className="text-[13px] text-text-500">{v.name}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-[13px] text-text-700">
                    {v.barcode ? <span className="font-mono">{v.barcode}</span> : t("skuAsBarcode")}
                  </TableCell>
                  <TableCell className="text-right">
                    <Input
                      inputMode="numeric"
                      className="tabular ml-auto w-20 text-right"
                      value={copies[v.id] ?? ""}
                      aria-label={t("copiesOf", { sku: v.sku })}
                      aria-invalid={bad ? true : undefined}
                      onChange={(e) => setCopies((all) => ({ ...all, [v.id]: e.target.value }))}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {problems.invalid.length > 0 ? (
        <p role="alert" className="text-sm text-danger">
          {t("copiesInvalid")}
        </p>
      ) : problems.tooMany ? (
        <p role="alert" className="text-sm text-danger">
          {t("tooMany", { total: problems.total })}
        </p>
      ) : null}
      <div className="grid gap-1.5">
        <span className="text-sm font-medium text-text-700">{t("format")}</span>
        <Segmented
          value={format}
          options={LABEL_FORMATS.map((f) => ({ value: f, label: t(`format_${f}`) }))}
          onChange={setFormat}
          label={t("format")}
          block
        />
      </div>
      <PrintSettingsPanel settings={settings} onChange={setSettings} showLabelOptions={false} />
      {document.data ? <DocumentResult document={document.data} /> : null}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {tCommon("close")}
        </Button>
        <Button type="submit" disabled={blocked} loading={make.isPending}>
          <Printer aria-hidden />
          {settings.deviceId ? t("print", { count: problems.total }) : t("makePdf", { count: problems.total })}
        </Button>
      </DialogFooter>
    </form>
  );
}
