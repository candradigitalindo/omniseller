"use client";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
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
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { pending } from "./contracts";
import { useInboxReceipt } from "./hooks";
import { InboxStatus } from "./inbox-status";

export function NewConversationDialog({
  principalId,
  accessKey,
  onClose,
}: {
  principalId: string;
  accessKey: string;
  onClose: () => void;
}) {
  const t = useTranslations("commerceInbox");
  const [buyerUserId, setBuyerUserId] = useState("");
  const attempt = useRef<{ buyer: string; key: string } | undefined>(undefined);
  const create = useMutation({
    mutationFn: () => {
      if (attempt.current?.buyer !== buyerUserId) attempt.current = { buyer: buyerUserId, key: crypto.randomUUID() };
      return unwrap(
        api.POST("/v1/commerce-inbox/conversations", {
          body: { principalId, buyerUserId },
          params: { header: { "Idempotency-Key": attempt.current.key } },
        }),
      );
    },
  });
  const receipt = useInboxReceipt(create.data?.id, accessKey);
  const busy = create.isPending || pending(receipt.data?.status);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("newConversation")}</DialogTitle>
          <DialogDescription>{t("buyerUserHint")}</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-2">
          <label htmlFor="inbox-buyer-user" className="text-sm font-medium">
            {t("buyerUser")}
          </label>
          <Input
            id="inbox-buyer-user"
            inputMode="numeric"
            value={buyerUserId}
            onChange={(event) => setBuyerUserId(event.target.value)}
            disabled={busy || Boolean(create.data)}
          />
        </div>
        {create.data ? (
          receipt.data?.status === "succeeded" ? (
            <p role="status" className="text-sm text-success">
              {t("createdConversation")}
            </p>
          ) : (
            <InboxStatus status={receipt.data?.status} loading={receipt.isPending} />
          )
        ) : null}
        {create.error || receipt.error ? (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(create.error ?? receipt.error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("close")}
          </Button>
          <Button
            disabled={!/^\d{1,30}$/.test(buyerUserId) || busy || Boolean(create.data)}
            onClick={() => create.mutate()}
          >
            {t(create.isPending ? "sending" : "createConversation")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
