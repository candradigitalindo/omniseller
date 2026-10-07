"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Pencil, Trash2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { FormBanner } from "@/components/common/form";
import { StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fileToBase64 } from "@/lib/file";
import { formatDate } from "@/lib/format";
import {
  type BusinessDocument,
  type BusinessProfile,
  DOCUMENT_KINDS,
  DOCUMENT_TYPES,
  type DocumentKind,
  documentBadge,
  MAX_DOCUMENT_BYTES,
} from "./business-meta";

const profileKey = ["business", "profile"] as const;

/**
 * "Dokumen legalitas" (L47): NIB, NPWP, SPPKP, deeds, and licences with how long each is valid; OmniSeller
 * reminds 30 and 7 days before one ends. A renewed document gets its new end date (or a new upload).
 */
export function DocumentsCard({ profile: p }: { profile: BusinessProfile }) {
  const t = useTranslations("business");
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BusinessDocument | null>(null);
  const [removing, setRemoving] = useState<BusinessDocument | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: profileKey });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/v1/business-documents/{id}", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success(t("documentRemoved", { title: removing?.title ?? "" }));
      setRemoving(null);
      void refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <CardTitle>
            <h2>{t("documentsTitle")}</h2>
          </CardTitle>
          <CardDescription>{t("documentsBody")}</CardDescription>
        </div>
        <Button variant="secondary" onClick={() => setAdding(true)}>
          <Upload aria-hidden />
          {t("upload")}
        </Button>
      </CardHeader>
      <CardContent>
        {p.documents.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-text-500">
            {t("noDocuments")}
          </p>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label={t("documentsTitle")}>
            {p.documents.map((d) => (
              <DocumentRow
                key={d.id}
                doc={d}
                timezone={p.timezone}
                onEdit={() => setEditing(d)}
                onRemove={() => setRemoving(d)}
              />
            ))}
          </ul>
        )}
      </CardContent>
      <UploadDialog open={adding} onClose={() => setAdding(false)} onDone={() => void refresh()} />
      <EditDialog doc={editing} onClose={() => setEditing(null)} onDone={() => void refresh()} />
      <Dialog open={removing !== null} onOpenChange={(v) => !v && setRemoving(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("removeTitle", { title: removing?.title ?? "" })}</DialogTitle>
            <DialogDescription>{t("removeBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              {t("keep")}
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() => removing && remove.mutate(removing.id)}
            >
              {t("remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function DocumentRow({
  doc: d,
  timezone,
  onEdit,
  onRemove,
}: {
  doc: BusinessDocument;
  timezone: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations("business");
  const badge = documentBadge(d);
  const kindName = t(`kind_${d.kind}`);
  return (
    <li className="flex flex-wrap items-center gap-3 p-3">
      <FileText className="size-5 shrink-0 text-primary" aria-hidden />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="font-medium text-text-900">
          {d.title}
          {d.title !== kindName ? <span className="font-normal text-text-500"> · {kindName}</span> : null}
        </span>
        <span className="text-[13px] text-text-500">
          {[
            d.number ? t("numberOf", { number: d.number }) : null,
            d.issuedOn ? t("issuedOn", { date: formatDate(d.issuedOn, timezone) }) : null,
            d.fileName,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <StatusPill tone={badge.tone}>
        {t(badge.key, {
          date: d.validUntil ? formatDate(d.validUntil, timezone) : "",
          days: d.daysLeft ?? 0,
        })}
      </StatusPill>
      <div className="flex gap-1">
        <Button asChild variant="ghost" size="sm">
          <a
            href={`/v1/business-documents/${d.id}/file`}
            target="_blank"
            rel="noopener"
            aria-label={t("viewNamed", { title: d.title })}
          >
            {t("view")}
          </a>
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={t("editNamed", { title: d.title })}>
          <Pencil aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-danger"
          onClick={onRemove}
          aria-label={t("removeNamed", { title: d.title })}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
    </li>
  );
}

interface Dates {
  issuedOn: string;
  validUntil: string;
  forever: boolean;
}

function DateFields({ value, onChange, idPrefix }: { value: Dates; onChange: (v: Dates) => void; idPrefix: string }) {
  const t = useTranslations("business");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-issued`}>{t("issuedOnLabel")}</Label>
        <Input
          id={`${idPrefix}-issued`}
          type="date"
          value={value.issuedOn}
          onChange={(e) => onChange({ ...value, issuedOn: e.target.value })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-until`}>{t("validUntilLabel")}</Label>
        <Input
          id={`${idPrefix}-until`}
          type="date"
          value={value.forever ? "" : value.validUntil}
          disabled={value.forever}
          onChange={(e) => onChange({ ...value, validUntil: e.target.value })}
        />
        <span className="flex items-center gap-2">
          <Checkbox
            id={`${idPrefix}-forever`}
            checked={value.forever}
            onCheckedChange={(v) => onChange({ ...value, forever: v === true })}
          />
          <Label htmlFor={`${idPrefix}-forever`} className="text-[13px] font-normal text-text-700">
            {t("forever")}
          </Label>
        </span>
      </div>
    </div>
  );
}

type UploadProblem = "untilRequired" | "untilBeforeIssued" | "fileRequired" | "fileInvalid" | "titleRequired";

const datesProblem = (d: Dates): "untilRequired" | "untilBeforeIssued" | null =>
  !d.forever && !d.validUntil
    ? "untilRequired"
    : !d.forever && d.issuedOn && d.validUntil < d.issuedOn
      ? "untilBeforeIssued"
      : null;

function UploadDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("business");
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("uploadTitle")}</DialogTitle>
          <DialogDescription>{t("uploadBody")}</DialogDescription>
        </DialogHeader>
        {open ? <UploadForm onClose={onClose} onDone={onDone} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function UploadForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations("business");
  const [kind, setKind] = useState<DocumentKind>("nib");
  const [title, setTitle] = useState("");
  const [number, setNumber] = useState("");
  const [dates, setDates] = useState<Dates>({ issuedOn: "", validUntil: "", forever: false });
  const [file, setFile] = useState<File | null>(null);
  const [tried, setTried] = useState(false);
  const [banner, setBanner] = useState<string | undefined>();
  const fileProblem: UploadProblem | null = !file
    ? "fileRequired"
    : file.size > MAX_DOCUMENT_BYTES || !DOCUMENT_TYPES.split(",").includes(file.type)
      ? "fileInvalid"
      : null;
  const dateProblem = datesProblem(dates);
  const titleProblem: UploadProblem | null = kind === "other" && !title.trim() ? "titleRequired" : null;
  const add = useMutation({
    mutationFn: async (f: File) =>
      unwrap(
        api.POST("/v1/business-documents", {
          body: {
            kind,
            ...(title.trim() ? { title: title.trim() } : {}),
            ...(number.trim() ? { number: number.trim() } : {}),
            ...(dates.issuedOn ? { issuedOn: dates.issuedOn } : {}),
            validUntil: dates.forever ? null : dates.validUntil,
            fileName: f.name,
            content: await fileToBase64(f),
          },
        }),
      ),
    onSuccess: (d) => {
      toast.success(t("documentAdded", { title: d.title }));
      onDone();
      onClose();
    },
    onError: (error) => setBanner(errorMessage(error)),
  });
  const show = (problem: UploadProblem | null) =>
    tried && problem ? (
      <p role="alert" className="text-[13px] text-danger">
        {t(`problem_${problem}`)}
      </p>
    ) : null;

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        setBanner(undefined);
        if (fileProblem || dateProblem || titleProblem || !file) return;
        add.mutate(file);
      }}
    >
      <FormBanner message={banner} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="doc-kind">{t("kind")}</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as DocumentKind)}>
            <SelectTrigger id="doc-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DOCUMENT_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`kind_${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="doc-number">{t("number")}</Label>
          <Input id="doc-number" value={number} maxLength={60} onChange={(e) => setNumber(e.target.value)} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="doc-title">{t(kind === "other" ? "titleRequired" : "titleOptional")}</Label>
        <Input
          id="doc-title"
          value={title}
          maxLength={120}
          placeholder={t(`kind_${kind}`)}
          onChange={(e) => setTitle(e.target.value)}
        />
        {show(titleProblem)}
      </div>
      <DateFields value={dates} onChange={setDates} idPrefix="doc" />
      {show(dateProblem)}
      <div className="grid gap-1.5">
        <Label htmlFor="doc-file">{t("file")}</Label>
        <Input
          id="doc-file"
          type="file"
          accept={DOCUMENT_TYPES}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          aria-describedby="doc-file-hint"
        />
        <p id="doc-file-hint" className="text-[13px] text-text-500">
          {t("fileHint")}
        </p>
        {show(fileProblem)}
      </div>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button type="submit" loading={add.isPending}>
          <Upload aria-hidden />
          {t("upload")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditDialog({
  doc,
  onClose,
  onDone,
}: {
  doc: BusinessDocument | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("business");
  return (
    <Dialog open={doc !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("editTitle", { title: doc?.title ?? "" })}</DialogTitle>
          <DialogDescription>{t("editBody")}</DialogDescription>
        </DialogHeader>
        {doc ? <EditForm key={doc.id} doc={doc} onClose={onClose} onDone={onDone} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({ doc, onClose, onDone }: { doc: BusinessDocument; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("business");
  const [title, setTitle] = useState(doc.title);
  const [number, setNumber] = useState(doc.number ?? "");
  const [dates, setDates] = useState<Dates>({
    issuedOn: doc.issuedOn ?? "",
    validUntil: doc.validUntil ?? "",
    forever: doc.validUntil === null,
  });
  const [tried, setTried] = useState(false);
  const [banner, setBanner] = useState<string | undefined>();
  const problem = datesProblem(dates);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/v1/business-documents/{id}", {
          params: { path: { id: doc.id } },
          body: {
            title: title.trim(),
            number: number.trim() || null,
            issuedOn: dates.issuedOn || null,
            validUntil: dates.forever ? null : dates.validUntil,
          },
        }),
      ),
    onSuccess: (d) => {
      toast.success(t("documentSaved", { title: d.title }));
      onDone();
      onClose();
    },
    onError: (error) => setBanner(errorMessage(error)),
  });
  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        setBanner(undefined);
        if (!problem) save.mutate();
      }}
    >
      <FormBanner message={banner} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="edit-title">{t("titleOptional")}</Label>
          <Input id="edit-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="edit-number">{t("number")}</Label>
          <Input id="edit-number" value={number} maxLength={60} onChange={(e) => setNumber(e.target.value)} />
        </div>
      </div>
      <DateFields value={dates} onChange={setDates} idPrefix="edit" />
      {tried && problem ? (
        <p role="alert" className="text-[13px] text-danger">
          {t(`problem_${problem}`)}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button type="submit" loading={save.isPending}>
          {t("saveDocument")}
        </Button>
      </DialogFooter>
    </form>
  );
}
