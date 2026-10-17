"use client";
import { useMutation } from "@tanstack/react-query";
import { CheckCheck, ExternalLink, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CommerceOperation, CommercePrincipal } from "@/features/commerce/contracts";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatDateTime } from "@/lib/format";
import { useTimeZone } from "@/lib/session";
import { type InboxConversation, pending } from "./contracts";
import { useInboxPage, useInboxReceipt } from "./hooks";
import { InboxStatus } from "./inbox-status";
import { ReplyComposer } from "./reply-composer";

export function ConversationDialog({
  conversation,
  principal,
  accessKey,
  canWrite,
  imageOperation,
  videoOperation,
  onClose,
}: {
  conversation: InboxConversation;
  principal: CommercePrincipal;
  accessKey: string;
  canWrite: boolean;
  imageOperation?: CommerceOperation;
  videoOperation?: CommerceOperation;
  onClose: () => void;
}) {
  const t = useTranslations("commerceInbox");
  const zone = useTimeZone();
  const [cursors, setCursors] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const messages = useInboxPage("messages", principal.id, conversation.id, cursors.at(-1), refresh, accessKey);
  const reload = useCallback(() => {
    setCursors([]);
    setRefresh((value) => value + 1);
  }, []);
  const read = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/commerce-inbox/messages/read", {
          body: { principalId: principal.id, conversationId: conversation.id },
          params: { header: { "Idempotency-Key": crypto.randomUUID() } },
        }),
      ),
  });
  const readReceipt = useInboxReceipt(read.data?.id, accessKey);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="break-words">
            {conversation.name || t("conversation", { id: conversation.id.slice(-6) })}
          </DialogTitle>
          <DialogDescription>{principal.name} · Tokopedia &amp; Shop</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={messages.loading} onClick={reload}>
              <RefreshCw aria-hidden />
              {t("refresh")}
            </Button>
            {canWrite && !principal.readOnly ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={read.isPending || pending(readReceipt.data?.status)}
                onClick={() => read.mutate()}
              >
                <CheckCheck aria-hidden />
                {t("read")}
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-text-500">{t("readHint")}</p>
          {read.data ? <InboxStatus status={readReceipt.data?.status} loading={readReceipt.isPending} /> : null}
          {messages.error || read.error || readReceipt.error ? (
            <p role="alert" className="text-sm text-danger">
              {errorMessage(messages.error ?? read.error ?? readReceipt.error)}
            </p>
          ) : null}
          {messages.loading || ["failed", "uncertain"].includes(messages.data?.status ?? "") ? (
            <InboxStatus loading={messages.loading} status={messages.data?.status} />
          ) : null}
          <div
            className="grid max-h-[35dvh] min-h-24 min-w-0 gap-3 overflow-y-auto rounded-xl border border-border p-3"
            role="log"
            aria-label={t("title")}
          >
            {messages.data?.messages.length === 0 && !messages.loading ? (
              <p className="text-sm text-text-500">{t("messageEmpty")}</p>
            ) : null}
            {[...(messages.data?.messages ?? [])].reverse().map((message) => (
              <article
                key={message.id}
                className={`grid max-w-[92%] min-w-0 gap-1 rounded-xl p-3 text-sm ${message.incoming ? "justify-self-start bg-surface-2" : "justify-self-end bg-primary-100"}`}
              >
                <p className="font-medium break-words">{message.sender || t(message.incoming ? "buyer" : "shop")}</p>
                <p className="break-words whitespace-pre-wrap">{message.text || t("unsupportedMessage")}</p>
                {message.mediaUrl ? (
                  <a
                    className="inline-flex items-center gap-1 text-primary underline"
                    href={message.mediaUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                  >
                    <ExternalLink className="size-3" aria-hidden />
                    {t("attachment")}
                  </a>
                ) : null}
                {message.createdAt ? (
                  <time dateTime={message.createdAt} className="text-xs text-text-500">
                    {formatDateTime(message.createdAt, zone)}
                  </time>
                ) : null}
              </article>
            ))}
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={!cursors.length || messages.loading}
              onClick={() => setCursors((items) => items.slice(0, -1))}
            >
              {t("newer")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!messages.data?.nextCursor || messages.loading}
              onClick={() => setCursors((items) => [...items, messages.data!.nextCursor!])}
            >
              {t("older")}
            </Button>
          </div>
          {principal.readOnly ? (
            <p className="text-sm text-text-500">{t("readOnly")}</p>
          ) : !canWrite ? (
            <p className="text-sm text-text-500">{t("writeAccess")}</p>
          ) : !conversation.canReply ? (
            <p className="text-sm text-text-500">{t("replyUnavailable")}</p>
          ) : (
            <ReplyComposer
              principalId={principal.id}
              conversationId={conversation.id}
              accessKey={accessKey}
              imageOperation={imageOperation}
              videoOperation={videoOperation}
              onSent={reload}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
