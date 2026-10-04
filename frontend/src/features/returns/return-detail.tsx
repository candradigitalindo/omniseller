"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { AlertTriangle, ExternalLink, ImagePlus, RefreshCw, Trash2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChannelIcon } from "@/components/common/channel";
import { ErrorState, StatusPill } from "@/components/common/page";
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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useStores } from "@/features/stores/use-store-modes";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { formatDateTime, formatNumber, formatRupiah } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import {
  canReceive,
  type Decision,
  type DecisionReason,
  fileToBase64,
  MAX_EVIDENCE,
  MAX_EVIDENCE_BYTES,
  RETURN_TONE,
  type ReceiptLine,
  type ReturnDetail,
  receiptDefaults,
  receiptLineProblem,
} from "./return-meta";
import { Deadline } from "./returns-view";

const POLL_MS = 5_000;

/** The detail of one request in a side panel (L09), full width on phones; its id lives in the URL. */
export function ReturnDetailSheet({ returnId, onClose }: { returnId: string | null; onClose: () => void }) {
  const t = useTranslations("returns");
  return (
    <Sheet open={returnId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[480px]">
        {returnId ? (
          <ReturnDetailBody key={returnId} id={returnId} />
        ) : (
          <SheetTitle className="sr-only">{t("detailTitle")}</SheetTitle>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ReturnDetailBody({ id }: { id: string }) {
  const t = useTranslations("returns");
  const detail = useQuery({
    queryKey: ["returns", "detail", id],
    queryFn: () => unwrap(api.GET("/v1/returns/{id}", { params: { path: { id } } })),
    // the worker is reading the marketplace or sending the answer: follow it
    refetchInterval: (q) =>
      q.state.data && (q.state.data.decisions === null || q.state.data.response?.status === "pending")
        ? POLL_MS
        : false,
  });
  if (detail.isPending) {
    return (
      <div className="grid gap-3 p-4" aria-busy>
        <SheetTitle className="sr-only">{t("detailTitle")}</SheetTitle>
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-32" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <>
        <SheetHeader className="border-b">
          <SheetTitle>{t("detailTitle")}</SheetTitle>
        </SheetHeader>
        <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
      </>
    );
  }
  return <ReturnDetailContent r={detail.data} />;
}

function ReturnDetailContent({ r }: { r: ReturnDetail }) {
  const t = useTranslations("returns");
  const can = useCan();
  const tz = useTimeZone();
  const queryClient = useQueryClient();
  const [accepting, setAccepting] = useState<Decision | null>(null);
  const [rejecting, setRejecting] = useState<Decision | null>(null);
  const marketplace = r.kind !== "rto";
  const readOnly = useStores().readOnly(r.store?.id);
  const respond = can("return:respond") && marketplace;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["returns"] });
  };
  const reread = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/returns/{id}/refresh", { params: { path: { id: r.id } } })),
    onSuccess: () => {
      toast.success(t("rereadQueued"));
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const accepts = r.decisions?.filter((d) => d.action === "accept") ?? [];
  const rejects = r.decisions?.filter((d) => d.action === "reject") ?? [];

  return (
    <>
      <SheetHeader className="gap-1.5 border-b pr-12">
        <SheetTitle className="flex items-center gap-2">
          <span>{t(`kind_${r.kind}`)}</span>
          <StatusPill tone={RETURN_TONE[r.status]}>{t(`status_${r.status}`)}</StatusPill>
        </SheetTitle>
        <SheetDescription asChild>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            {r.externalOrderId ? (
              <Link href={`/pesanan?id=${r.orderId}`} className="font-mono text-primary hover:underline">
                {r.externalOrderId}
              </Link>
            ) : null}
            {r.store ? (
              <span className="flex items-center gap-1.5">
                <ChannelIcon channel={r.store.channel} decorative />
                {r.store.name}
              </span>
            ) : null}
            <span>{formatDateTime(r.createdAt, tz)}</span>
          </div>
        </SheetDescription>
      </SheetHeader>

      <div className="grid flex-1 content-start gap-3 overflow-y-auto bg-canvas p-4">
        {r.awaitingDecision && r.respondByAt ? (
          <p className="flex items-start gap-2 rounded-[10px] border border-warning/30 bg-warning-soft p-3 text-sm text-text-900">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <span className="grid gap-1">
              <span>{t("answerBy", { at: formatDateTime(r.respondByAt, tz) })}</span>
              <Deadline row={r} now={Date.now()} />
            </span>
          </p>
        ) : null}

        <Section title={t("buyerTitle")}>
          <dl className="grid gap-1.5 text-sm">
            <Row label={t("reason")} value={r.reason ?? "—"} />
            {r.refundAmount !== null ? <Row label={t("refundAmount")} value={formatRupiah(r.refundAmount)} /> : null}
            {r.initiator ? <Row label={t("initiator")} value={t(`initiator_${r.initiator}`)} /> : null}
            {r.returnTrackingNumber ? (
              <Row
                label={t("returnShipping")}
                value={[r.returnCarrier, r.returnTrackingNumber].filter(Boolean).join(" · ")}
              />
            ) : null}
          </dl>
          {r.evidence.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label={t("buyerEvidence")}>
              {r.evidence.map((e) => (
                <li key={e.url}>
                  <a
                    href={e.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="relative block size-20 overflow-hidden rounded-lg border bg-surface-2"
                    title={t(e.type === "video" ? "openVideo" : "openPhoto")}
                  >
                    {e.thumbnailUrl || e.type === "image" ? (
                      <Image
                        src={e.thumbnailUrl ?? e.url}
                        alt={t(e.type === "video" ? "evidenceVideo" : "evidencePhoto")}
                        width={80}
                        height={80}
                        unoptimized
                        className="size-20 object-cover"
                      />
                    ) : (
                      <span className="grid size-20 place-items-center text-[12px] text-text-500">{t("video")}</span>
                    )}
                    <ExternalLink
                      className="absolute right-1 bottom-1 size-3.5 rounded bg-surface/80 text-text-700"
                      aria-hidden
                    />
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>

        <Section title={t("itemsTitle", { count: r.items.length })}>
          <ul className="grid gap-2">
            {r.items.map((i) => (
              <li key={i.id} className="flex items-start justify-between gap-3 text-sm">
                <span className="grid min-w-0 gap-0.5">
                  <span className="line-clamp-2 font-medium text-text-900">{i.title ?? "—"}</span>
                  <span className="truncate font-mono text-[13px] text-text-700">{i.sku ?? "—"}</span>
                  {i.receivedAt ? (
                    <span className="text-[13px] text-text-500">
                      {t("receivedLine", {
                        sellable: i.sellableQty ?? 0,
                        damaged: i.damagedQty ?? 0,
                        missing: i.missingQty ?? 0,
                      })}
                    </span>
                  ) : null}
                </span>
                <span className="tabular shrink-0 text-text-700">×{formatNumber(i.qty)}</span>
              </li>
            ))}
          </ul>
        </Section>

        {r.response ? (
          <Section title={t("responseTitle")}>
            <dl className="grid gap-1.5 text-sm">
              <Row label={t("decision")} value={r.response.label} />
              {r.response.reasonLabel ? <Row label={t("reason")} value={r.response.reasonLabel} /> : null}
              {r.response.comment ? <Row label={t("comment")} value={r.response.comment} /> : null}
              <Row label={t("responseState")} value={t(`response_${r.response.status}`)} />
              {r.response.decidedAt ? (
                <Row label={t("decidedAt")} value={formatDateTime(r.response.decidedAt, tz)} />
              ) : null}
            </dl>
            {r.response.status === "failed" && r.response.error ? (
              <p className="text-[13px] text-danger">{r.response.error}</p>
            ) : null}
          </Section>
        ) : null}

        {readOnly && marketplace && r.awaitingDecision ? (
          <p className="flex items-start gap-2 rounded-[10px] border bg-surface-2 p-3 text-sm text-text-700">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <span>{t("storeReadOnly", { store: readOnly.name })}</span>
          </p>
        ) : null}

        {respond && !readOnly && (r.awaitingDecision || r.decisions === null) ? (
          <Section title={t("decideTitle")}>
            {r.decisions === null ? (
              <p className="text-sm text-text-700" aria-live="polite">
                {t("decisionsReading")}
              </p>
            ) : accepts.length + rejects.length === 0 ? (
              <p className="text-sm text-text-700">{t("nothingToDecide")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {accepts.map((d, i) => (
                  <Button key={d.code} variant={i === 0 ? "default" : "secondary"} onClick={() => setAccepting(d)}>
                    {d.label}
                  </Button>
                ))}
                {rejects.map((d) => (
                  <Button key={d.code} variant="secondary" onClick={() => setRejecting(d)}>
                    {d.label}
                  </Button>
                ))}
              </div>
            )}
          </Section>
        ) : null}

        {r.receivedAt ? (
          <Section title={t("receiptTitle")}>
            <p className="text-sm text-text-700">{t("receivedAt", { at: formatDateTime(r.receivedAt, tz) })}</p>
            {r.receiptNote ? <p className="text-sm whitespace-pre-wrap text-text-700">{r.receiptNote}</p> : null}
          </Section>
        ) : can("return:receive") && canReceive(r) ? (
          <ReceiveForm r={r} onDone={refresh} />
        ) : null}

        {respond ? (
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            loading={reread.isPending}
            onClick={() => reread.mutate()}
          >
            <RefreshCw aria-hidden />
            {t("reread")}
          </Button>
        ) : null}
      </div>

      <AcceptDialog r={r} decision={accepting} onClose={() => setAccepting(null)} onDone={refresh} />
      <RejectDialog r={r} decision={rejecting} onClose={() => setRejecting(null)} onDone={refresh} />
    </>
  );
}

function Section({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("grid gap-3 rounded-[10px] border bg-surface p-4", className)}>
      <h3 className="text-[15px] font-semibold text-text-900">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-text-500">{label}</dt>
      <dd className="text-right text-text-900">{value}</dd>
    </div>
  );
}

function AcceptDialog({
  r,
  decision,
  onClose,
  onDone,
}: {
  r: ReturnDetail;
  decision: Decision | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("returns");
  const tCommon = useTranslations("common");
  const accept = useMutation({
    mutationFn: (code: string) =>
      unwrap(api.POST("/v1/returns/{id}/accept", { params: { path: { id: r.id } }, body: { decision: code } })),
    onSuccess: () => {
      toast.success(t("decisionSent"));
      onDone();
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Dialog open={decision !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{decision?.label}</DialogTitle>
          <DialogDescription>
            {r.refundAmount !== null && r.kind !== "cancellation"
              ? t("acceptBodyRefund", { amount: formatRupiah(r.refundAmount) })
              : t("acceptBody")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button loading={accept.isPending} onClick={() => decision && accept.mutate(decision.code)}>
            {t("confirmDecision")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Photo = { fileId: string; module: number | null; preview: string; name: string };

function RejectDialog({
  r,
  decision,
  onClose,
  onDone,
}: {
  r: ReturnDetail;
  decision: Decision | null;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Dialog open={decision !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[540px]">
        {decision ? (
          <RejectForm key={decision.code} r={r} decision={decision} onClose={onClose} onDone={onDone} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RejectForm({
  r,
  decision,
  onClose,
  onDone,
}: {
  r: ReturnDetail;
  decision: Decision;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("returns");
  const tCommon = useTranslations("common");
  const [reasonCode, setReasonCode] = useState<string>(decision.reasons[0]?.code ?? "");
  const [comment, setComment] = useState("");
  const [email, setEmail] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const reason: DecisionReason | undefined = decision.reasons.find((x) => x.code === reasonCode);
  const previews = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const upload = useMutation({
    mutationFn: async ({ file, module }: { file: File; module: number | null }) => {
      const content = await fileToBase64(file);
      const saved = await unwrap(
        api.POST("/v1/returns/{id}/evidence", { params: { path: { id: r.id } }, body: { content } }),
      );
      return { saved, file, module };
    },
    onSuccess: ({ saved, file, module }) => {
      const preview = URL.createObjectURL(file);
      previews.current.push(preview);
      setPhotos((prev) => [...prev, { fileId: saved.fileId, module, preview, name: file.name }]);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const pick = (files: FileList | null, module: number | null) => {
    for (const file of Array.from(files ?? [])) {
      if (photos.length + 1 > MAX_EVIDENCE) {
        toast.error(t("tooManyPhotos", { max: MAX_EVIDENCE }));
        return;
      }
      if (file.type !== "image/jpeg" && file.type !== "image/png") {
        toast.error(t("photoType"));
        continue;
      }
      if (file.size > MAX_EVIDENCE_BYTES) {
        toast.error(t("photoTooLarge"));
        continue;
      }
      upload.mutate({ file, module });
    }
  };

  const reject = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/returns/{id}/reject", {
          params: { path: { id: r.id } },
          body: {
            decision: decision.code,
            ...(reasonCode ? { reason: reasonCode } : {}),
            ...(comment.trim() ? { comment: comment.trim() } : {}),
            ...(decision.needsEmail ? { email: email.trim() } : {}),
            evidence: photos.map((p) => ({ fileId: p.fileId, ...(p.module === null ? {} : { module: p.module }) })),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(t("decisionSent"));
      onDone();
      onClose();
    },
    onError: (error) =>
      setProblem(error instanceof ApiError ? (error.errors[0]?.message ?? errorMessage(error)) : errorMessage(error)),
  });

  const missingEvidence = (reason?.evidence ?? []).filter(
    (e) => e.required && !photos.some((p) => p.module === e.module),
  );
  const submit = () => {
    if (decision.reasons.length > 0 && !reasonCode) return setProblem(t("chooseReason"));
    if (missingEvidence.length > 0) return setProblem(t("evidenceRequired", { what: missingEvidence[0]!.requirement }));
    if (decision.needsEmail && !/^\S+@\S+\.\S+$/.test(email.trim())) return setProblem(t("emailRequired"));
    setProblem(null);
    reject.mutate();
  };

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{decision.label}</DialogTitle>
        <DialogDescription>{t("rejectBody")}</DialogDescription>
      </DialogHeader>

      {decision.reasons.length > 0 ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1.5 text-sm font-medium text-text-700">{t("reason")}</legend>
          <RadioGroup value={reasonCode} onValueChange={setReasonCode} className="gap-2">
            {decision.reasons.map((x) => (
              <div key={x.code} className="flex items-center gap-3 rounded-lg border p-3">
                <RadioGroupItem value={x.code} id={`reason-${x.code}`} />
                <Label htmlFor={`reason-${x.code}`} className="font-normal text-text-900">
                  {x.label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </fieldset>
      ) : null}

      <div className="grid gap-2">
        <span className="text-sm font-medium text-text-700">{t("sellerEvidence")}</span>
        {(reason?.evidence.length ?? 0) > 0 ? (
          <ul className="grid gap-2">
            {reason!.evidence.map((e) => (
              <li key={e.module} className="grid gap-2 rounded-lg border p-3">
                <span className="text-sm text-text-900">
                  {e.requirement}
                  {e.required ? <span className="text-danger"> *</span> : null}
                </span>
                <PhotoRow
                  photos={photos.filter((p) => p.module === e.module)}
                  onRemove={(id) => setPhotos((prev) => prev.filter((p) => p.fileId !== id))}
                />
                <PhotoPicker busy={upload.isPending} onPick={(files) => pick(files, e.module)} />
              </li>
            ))}
          </ul>
        ) : (
          <>
            <PhotoRow photos={photos} onRemove={(id) => setPhotos((prev) => prev.filter((p) => p.fileId !== id))} />
            <PhotoPicker busy={upload.isPending} onPick={(files) => pick(files, null)} />
          </>
        )}
        <span className="text-[13px] text-text-500">{t("photoHint", { max: MAX_EVIDENCE })}</span>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="reject-comment">{t("comment")}</Label>
        <Textarea
          id="reject-comment"
          rows={3}
          maxLength={1000}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
      {decision.needsEmail ? (
        <div className="grid gap-1.5">
          <Label htmlFor="reject-email">{t("contactEmail")}</Label>
          <Input
            id="reject-email"
            type="email"
            autoComplete="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <span className="text-[13px] text-text-500">{t("contactEmailHint")}</span>
        </div>
      ) : null}

      <FormAlert message={problem} />
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button variant="destructive" loading={reject.isPending} disabled={upload.isPending} onClick={submit}>
          {t("sendDecision")}
        </Button>
      </DialogFooter>
    </div>
  );
}

function PhotoRow({ photos, onRemove }: { photos: Photo[]; onRemove: (fileId: string) => void }) {
  const t = useTranslations("returns");
  if (photos.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {photos.map((p) => (
        <li key={p.fileId} className="relative">
          {/* a local preview of what was just uploaded; never a remote address */}
          <Image
            src={p.preview}
            alt={p.name}
            width={64}
            height={64}
            unoptimized
            className="size-16 rounded-lg border object-cover"
          />
          <button
            type="button"
            onClick={() => onRemove(p.fileId)}
            className="absolute -top-1.5 -right-1.5 grid size-6 place-items-center rounded-full border bg-surface text-text-700 hover:text-danger"
            aria-label={t("removePhoto", { name: p.name })}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

function PhotoPicker({ busy, onPick }: { busy: boolean; onPick: (files: FileList | null) => void }) {
  const t = useTranslations("returns");
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          onPick(e.target.files);
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="justify-self-start"
        loading={busy}
        onClick={() => input.current?.click()}
      >
        <ImagePlus aria-hidden />
        {t("addPhoto")}
      </Button>
    </>
  );
}

/**
 * "Penerimaan barang" (L09, FR-RET-03): per line how many units came back sellable (back to stock),
 * damaged (quarantine), or not at all. Recorded once per request.
 */
function ReceiveForm({ r, onDone }: { r: ReturnDetail; onDone: () => void }) {
  const t = useTranslations("returns");
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<ReceiptLine[]>(() => receiptDefaults(r.items));
  const [warehouseId, setWarehouseId] = useState<string>(r.warehouseId ?? "");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // which order lines have a product behind them: the others can only be recorded as not received
  const order = useQuery({
    queryKey: ["orders", "detail", r.orderId],
    queryFn: () => unwrap(api.GET("/v1/orders/{id}", { params: { path: { id: r.orderId } } })),
    retry: false,
  });
  const warehouses = useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 300_000,
    retry: false,
  });
  const mapped = (orderItemId: string | null) => {
    if (!orderItemId) return false;
    const line = order.data?.items.find((i) => i.id === orderItemId);
    return line ? line.variantId !== null : true;
  };
  const receive = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/returns/{id}/receive", {
          params: { path: { id: r.id } },
          body: {
            ...(warehouseId ? { warehouseId } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
            items: lines,
          },
        }),
      ),
    onSuccess: () => {
      toast.success(t("receiptSaved"));
      void queryClient.invalidateQueries({ queryKey: ["stock"] });
      onDone();
    },
    onError: (error) =>
      setProblem(error instanceof ApiError ? (error.errors[0]?.message ?? errorMessage(error)) : errorMessage(error)),
  });
  const set = (index: number, key: "sellable" | "damaged" | "missing", value: string) => {
    const n = Number(value);
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, [key]: Number.isInteger(n) && n >= 0 ? n : 0 } : l)));
  };
  const problems = r.items.map((item, i) =>
    receiptLineProblem(lines[i]!, { qty: item.qty, mapped: mapped(item.orderItemId) }),
  );
  const visible = warehouses.data?.items.filter((w) => w.active) ?? [];

  return (
    <Section title={t("receiveTitle")}>
      <p className="text-sm text-text-700">{t("receiveBody")}</p>
      <ul className="grid gap-3">
        {r.items.map((item, i) => (
          <li key={item.id} className="grid gap-2 rounded-lg border p-3">
            <span className="flex items-start justify-between gap-2 text-sm">
              <span className="line-clamp-2 font-medium text-text-900">{item.title ?? item.sku ?? "—"}</span>
              <span className="tabular shrink-0 text-text-700">×{formatNumber(item.qty)}</span>
            </span>
            <div className="grid grid-cols-3 gap-2">
              {(["sellable", "damaged", "missing"] as const).map((key) => (
                <div key={key} className="grid gap-1 text-[13px] text-text-700">
                  <Label htmlFor={`receipt-${item.id}-${key}`} className="text-[13px] font-normal text-text-700">
                    {t(`receipt_${key}`)}
                  </Label>
                  <Input
                    id={`receipt-${item.id}-${key}`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={item.qty}
                    className="tabular"
                    value={String(lines[i]![key])}
                    onChange={(e) => set(i, key, e.target.value)}
                  />
                </div>
              ))}
            </div>
            {problems[i] ? (
              <span className="text-[13px] text-danger">
                {problems[i] === "total" ? t("receiptTotal", { qty: item.qty }) : t("receiptUnmapped")}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {visible.length > 1 ? (
        <div className="grid gap-1.5">
          <Label htmlFor="receive-warehouse">{t("receiveWarehouse")}</Label>
          <Select value={warehouseId} onValueChange={setWarehouseId}>
            <SelectTrigger id="receive-warehouse" className="w-full">
              <SelectValue placeholder={t("chooseWarehouse")} />
            </SelectTrigger>
            <SelectContent>
              {visible.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor="receive-note">{t("receiveNote")}</Label>
        <Textarea id="receive-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <FormAlert message={problem} />
      <Button
        className="justify-self-start"
        loading={receive.isPending}
        disabled={problems.some((p) => p !== null)}
        onClick={() => {
          setProblem(null);
          receive.mutate();
        }}
      >
        {t("saveReceipt")}
      </Button>
    </Section>
  );
}

/** A refusal next to the button that caused it, where the eye already is; read out when it appears. */
function FormAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
      {message}
    </p>
  );
}
