import type { paths } from "@/lib/api/schema";
export type InboxReceipt =
  paths["/v1/commerce-inbox/requests/{id}"]["get"]["responses"][200]["content"]["application/json"];
export type InboxConversation = InboxReceipt["conversations"][number];
export type InboxSend = paths["/v1/commerce-inbox/messages/send"]["post"]["requestBody"]["content"]["application/json"];
export const INBOX_UPLOAD_OPERATION = "tiktok_650a599d0fcef602bf2a1dc8";
export const INBOX_VIDEO_OPERATION = "tiktok_large_chat_video";
export const pending = (status?: string) => status === "queued" || status === "running";
