"use client";
import { useIsMutating, useMutation } from "@tanstack/react-query";
import { ImagePlus, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import type { CommerceInput, CommerceOperation } from "@/features/commerce/contracts";
import { CommerceFileField } from "@/features/commerce/file-field";
import { asObject, type DraftValue } from "@/features/commerce/form-values";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { type InboxSend, pending } from "./contracts";
import { useInboxReceipt } from "./hooks";
import { InboxStatus } from "./inbox-status";

export function ReplyComposer({
  principalId,
  conversationId,
  accessKey,
  imageOperation,
  videoOperation,
  onSent,
}: {
  principalId: string;
  conversationId: string;
  accessKey: string;
  imageOperation?: CommerceOperation;
  videoOperation?: CommerceOperation;
  onSent: () => void;
}) {
  const t = useTranslations("commerceInbox");
  const [type, setType] = useState<InboxSend["type"]>("TEXT");
  const [text, setText] = useState("");
  const [reference, setReference] = useState("");
  const [secondary, setSecondary] = useState("");
  const mediaOperation = type === "VIDEO" ? videoOperation : imageOperation;
  const [file, setFile] = useState<DraftValue>();
  const [confirm, setConfirm] = useState(false);
  const handled = useRef<string | undefined>(undefined);
  const sendAttempt = useRef<{ body: string; key: string } | undefined>(undefined);
  const uploadAttempt = useRef<{ fileId: string; key: string } | undefined>(undefined);
  const uploading = useIsMutating({ mutationKey: ["commerce", "upload", mediaOperation?.id, principalId] }) > 0;
  const upload = useMutation({
    mutationFn: () => {
      const fileId = asObject(file).fileId as string;
      const input: CommerceInput = { body: { data: fileId } };
      if (uploadAttempt.current?.fileId !== fileId) uploadAttempt.current = { fileId, key: crypto.randomUUID() };
      return unwrap(
        api.POST("/v1/commerce/requests", {
          params: { header: { "Idempotency-Key": uploadAttempt.current.key } },
          body: {
            operationId: mediaOperation!.id,
            principalId,
            input,
            confirmed: true,
          },
        }),
      );
    },
  });
  const imageReceipt = useInboxReceipt(upload.data?.id, accessKey);
  const send = useMutation({
    mutationFn: () => {
      const target = { principalId, conversationId };
      const body: InboxSend =
        type === "TEXT"
          ? { ...target, type, text: text.trim() }
          : type === "IMAGE" || type === "VIDEO"
            ? { ...target, type, uploadRequestId: upload.data!.id }
            : type === "PRODUCT_CARD"
              ? { ...target, type, productId: reference }
              : type === "ORDER_CARD"
                ? { ...target, type, orderId: reference }
                : type === "LOGISTICS_CARD"
                  ? { ...target, type, orderId: reference, ...(secondary ? { packageId: secondary } : {}) }
                  : type === "RETURN_REFUND_CARD"
                    ? { ...target, type, orderId: reference, skuId: secondary }
                    : { ...target, type, couponId: reference };
      const serialized = JSON.stringify(body);
      if (sendAttempt.current?.body !== serialized)
        sendAttempt.current = { body: serialized, key: crypto.randomUUID() };
      return unwrap(
        api.POST("/v1/commerce-inbox/messages/send", {
          body,
          params: { header: { "Idempotency-Key": sendAttempt.current.key } },
        }),
      );
    },
    onSuccess: () => setConfirm(false),
  });
  const receipt = useInboxReceipt(send.data?.id, accessKey);
  useEffect(() => {
    if (receipt.data?.status !== "succeeded" || handled.current === receipt.data.id) return;
    handled.current = receipt.data.id;
    sendAttempt.current = undefined;
    setText("");
    setReference("");
    setSecondary("");
    setFile(undefined);
    onSent();
  }, [receipt.data, onSent]);
  const busy = send.isPending || pending(receipt.data?.status) || receipt.data?.status === "uncertain";
  const imageBusy = upload.isPending || pending(imageReceipt.data?.status);
  const ready =
    type === "TEXT"
      ? text.trim().length > 0 && text.trim().length <= 2000
      : type === "IMAGE" || type === "VIDEO"
        ? imageReceipt.data?.status === "succeeded"
        : /^\d{1,30}$/.test(reference) &&
          (type !== "RETURN_REFUND_CARD" || /^\d{1,30}$/.test(secondary)) &&
          (type !== "LOGISTICS_CARD" || !secondary || /^\d{1,30}$/.test(secondary));
  const fileField = mediaOperation?.fields.find((field) => field.type === "file");
  return (
    <div className="grid min-w-0 gap-3 rounded-xl border border-border bg-surface-2 p-3">
      <h3 className="font-semibold">{t("reply")}</h3>
      <div className="grid gap-1.5">
        <label htmlFor="inbox-reply-type" className="text-sm font-medium">
          {t("type")}
        </label>
        <Select
          value={type}
          onValueChange={(value) => {
            setType(value as InboxSend["type"]);
            setFile(undefined);
            upload.reset();
            send.reset();
          }}
          disabled={busy || imageBusy || uploading}
        >
          <SelectTrigger id="inbox-reply-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(
              [
                "TEXT",
                "IMAGE",
                "VIDEO",
                "PRODUCT_CARD",
                "ORDER_CARD",
                "COUPON_CARD",
                "LOGISTICS_CARD",
                "RETURN_REFUND_CARD",
              ] as const
            ).map((value) => (
              <SelectItem key={value} value={value}>
                {t(`types.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {type === "TEXT" ? (
        <div className="grid gap-1.5">
          <label htmlFor="inbox-reply-text" className="text-sm font-medium">
            {t("text")}
          </label>
          <Textarea
            id="inbox-reply-text"
            className="max-h-28 resize-none"
            maxLength={2000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={busy}
          />
          <p className="text-xs text-text-500">{t("characters", { count: text.length.toLocaleString("id-ID") })}</p>
        </div>
      ) : type === "IMAGE" || type === "VIDEO" ? (
        <div className="grid gap-2">
          {fileField && mediaOperation?.available ? (
            <>
              <CommerceFileField
                id="inbox-reply-image"
                field={fileField}
                value={file}
                onChange={(value) => {
                  setFile(value);
                  upload.reset();
                }}
                context={{ operationId: mediaOperation!.id, principalId }}
                disabled={busy || imageBusy}
              />
              <p className="text-xs text-text-500">{t(type === "VIDEO" ? "videoHint" : "imageHint")}</p>
              <Button
                variant="secondary"
                size="sm"
                disabled={
                  !asObject(file).fileId || uploading || imageBusy || imageReceipt.data?.status === "succeeded" || busy
                }
                onClick={() => upload.mutate()}
              >
                <ImagePlus aria-hidden />
                {t("prepareImage")}
              </Button>
              {upload.data ? (
                imageReceipt.data?.status === "succeeded" ? (
                  <p role="status" className="text-sm text-success">
                    {t("mediaReady")}
                  </p>
                ) : (
                  <InboxStatus status={imageReceipt.data?.status} loading={imageReceipt.isPending} />
                )
              ) : null}
            </>
          ) : (
            <p className="text-sm text-text-500">{t("mediaUnavailable")}</p>
          )}
        </div>
      ) : (
        <div className="grid gap-1.5">
          <label htmlFor="inbox-reply-reference" className="text-sm font-medium">
            {t("reference")}
          </label>
          <Input
            id="inbox-reply-reference"
            inputMode="numeric"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            disabled={busy}
          />
          {type === "RETURN_REFUND_CARD" || type === "LOGISTICS_CARD" ? (
            <>
              <label htmlFor="inbox-reply-secondary" className="text-sm font-medium">
                {t(type === "RETURN_REFUND_CARD" ? "skuReference" : "packageReference")}
              </label>
              <Input
                id="inbox-reply-secondary"
                inputMode="numeric"
                value={secondary}
                onChange={(event) => setSecondary(event.target.value)}
                disabled={busy}
              />
            </>
          ) : null}
          <p className="text-xs text-text-500">{t("referenceHint")}</p>
        </div>
      )}
      {send.error || receipt.error || upload.error || imageReceipt.error ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(send.error ?? receipt.error ?? upload.error ?? imageReceipt.error)}
        </p>
      ) : null}
      {send.data ? <InboxStatus status={receipt.data?.status} loading={receipt.isPending} /> : null}
      <Button className="w-full" disabled={!ready || busy || imageBusy || uploading} onClick={() => setConfirm(true)}>
        <Send aria-hidden />
        {t("send")}
      </Button>
      <Dialog
        open={confirm}
        onOpenChange={(open) => {
          if (!send.isPending) setConfirm(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("confirmTitle")}</DialogTitle>
            <DialogDescription>{t("confirmHint")}</DialogDescription>
          </DialogHeader>
          <div className="min-w-0 rounded-xl bg-surface-2 p-3 text-sm break-words whitespace-pre-wrap">
            {type === "TEXT"
              ? text
              : `${t(`types.${type}`)}${["IMAGE", "VIDEO"].includes(type) ? "" : ` · ${reference}`}`}
          </div>
          <DialogFooter>
            <Button variant="secondary" disabled={send.isPending} onClick={() => setConfirm(false)}>
              {t("cancel")}
            </Button>
            <Button disabled={send.isPending} onClick={() => send.mutate()}>
              {t(send.isPending ? "sending" : "send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
