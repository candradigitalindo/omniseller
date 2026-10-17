import { describe, expect, it } from "vitest";
import { inboxConversations, inboxMessages, mediaUrl } from "./commerce-inbox-projection";

describe("commerce inbox projection", () => {
  it("never exposes invisible or unspecified-visibility message content", () => {
    expect(
      inboxMessages({
        messages: [
          { id: "1", is_visible: false, content: '{"content":"private rating prompt"}' },
          { id: "2", content: '{"content":"visibility unknown"}' },
          {
            id: "3",
            is_visible: true,
            type: "TEXT",
            content: '{"content":"Pesan pembeli"}',
            sender: { role: "BUYER", nickname: "Rina" },
            create_time: 1792200000,
          },
        ],
      }),
    ).toEqual([
      {
        id: "3",
        type: "TEXT",
        text: "Pesan pembeli",
        sender: "Rina",
        incoming: true,
        createdAt: new Date(1792200000000).toISOString(),
        mediaUrl: null,
      },
    ]);
  });
  it("does not surface raw JSON or invisible conversation previews", () => {
    expect(
      inboxConversations({
        conversations: [
          {
            id: "7494560109732334261",
            can_send_message: false,
            participants: [{ role: "BUYER", nickname: "Ayu" }],
            unread_count: 2,
            latest_message: { id: "2", is_visible: false, content: '{"content":"hidden"}' },
          },
        ],
      }),
    ).toEqual([{ id: "7494560109732334261", name: "Ayu", preview: "", unread: 2, canReply: false, updatedAt: null }]);
  });
  it("uses plaintext fallback and refuses active URL schemes", () => {
    expect(
      inboxMessages({
        messages: [
          { id: "1", type: "IMAGE", is_visible: true, content: '{"url":"javascript:alert(1)"}', plaintext: "Gambar" },
        ],
      })[0],
    ).toMatchObject({ text: "Gambar", mediaUrl: null });
    expect(mediaUrl("https://user:password@example.test/image")).toBeNull();
    expect(mediaUrl("http://example.test/image")).toBeNull();
    expect(mediaUrl("https://example.test/image")).toBe("https://example.test/image");
  });
  it("bounds provider collections and preserves exact string IDs", () => {
    expect(
      inboxMessages({ messages: Array.from({ length: 11 }, () => ({ id: "7494560109732334261", is_visible: true })) }),
    ).toHaveLength(10);
    expect(inboxConversations({ conversations: [{ id: 7494 }] })).toEqual([]);
  });
});
