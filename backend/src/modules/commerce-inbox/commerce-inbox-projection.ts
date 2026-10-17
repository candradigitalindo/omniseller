import { parseJsonSafe } from "@omniseller/connector-core";

export const INBOX_OPERATIONS = {
  create: "tiktok_650a5a0bf1fd3102b9245b8d",
  conversations: "tiktok_650a589f0fcef602bf29fecf",
  messages: "tiktok_650a587edefece02be664cd2",
  send: "tiktok_6a1ff121795c140490537a5c",
  read: "tiktok_650a59f7c16ffe02b8e8db3f",
  upload: "tiktok_650a599d0fcef602bf2a1dc8",
  video: "tiktok_large_chat_video",
} as const;
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const string = (value: unknown, limit = 2000) => (typeof value === "string" ? value.slice(0, limit) : "");
export function mediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
function timestamp(value: unknown): string | null {
  const seconds = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 253402300799) return null;
  return new Date(seconds * 1000).toISOString();
}
/** Explicit user-facing projection. Invisible marketplace messages never reach an agent's screen. */
export function inboxMessage(value: unknown) {
  const row = record(value);
  if (row.is_visible !== true || typeof row.id !== "string") return null;
  let content: Record<string, unknown> = {};
  if (typeof row.content === "string" && row.content.length <= 16384) {
    try {
      content = record(parseJsonSafe(row.content));
    } catch {
      /* Display the supported fallback below. */
    }
  }
  const sender = record(row.sender);
  const type = string(row.type, 80);
  const detail =
    type === "PRODUCT_CARD"
      ? string(content.product_id, 80)
      : type === "ORDER_CARD"
        ? string(content.order_id, 80)
        : type === "COUPON_CARD"
          ? string(content.coupon_id, 80)
          : "";
  return {
    id: row.id.slice(0, 100),
    type,
    text: string(content.content) || string(row.plaintext) || detail,
    sender: string(sender.nickname, 120),
    incoming: sender.role === "BUYER",
    createdAt: timestamp(row.create_time),
    mediaUrl: ["IMAGE", "VIDEO"].includes(type) ? mediaUrl(content.url) : null,
  };
}
export function inboxConversations(data: unknown) {
  const rows = record(data).conversations;
  return (Array.isArray(rows) ? rows.slice(0, 20) : []).flatMap((value) => {
    const row = record(value);
    if (typeof row.id !== "string") return [];
    const participants = Array.isArray(row.participants) ? row.participants : [];
    const buyer = participants.map(record).find((participant) => participant.role === "BUYER");
    const latest = inboxMessage(row.latest_message);
    return [
      {
        id: row.id.slice(0, 100),
        name: string(buyer?.nickname, 120),
        preview: latest?.text ?? "",
        unread:
          typeof row.unread_count === "number" && Number.isSafeInteger(row.unread_count)
            ? Math.max(0, row.unread_count)
            : 0,
        canReply: row.can_send_message === true,
        updatedAt: latest?.createdAt ?? timestamp(row.create_time),
      },
    ];
  });
}
export function inboxMessages(data: unknown) {
  const rows = record(data).messages;
  return (Array.isArray(rows) ? rows.slice(0, 10) : []).map(inboxMessage).filter((row) => row !== null);
}
