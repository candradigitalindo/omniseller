import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { CommercePrincipal } from "@/features/commerce/contracts";
import { mockApi, renderApp, testMe } from "@/test/render";
import { CommerceInboxView } from "./commerce-inbox-view";

const principal: CommercePrincipal = {
  id: "01JSTORE000000000000000001",
  kind: "seller",
  channel: "tiktokshop",
  name: "Toko Candra",
  status: "active",
  scopes: ["seller.customer_service"],
  region: "ID",
  readOnly: false,
  sellerType: "local",
  categories: [],
};
const readPermissions = ["commerce:read", "chat:read"] as const;
const writePermissions = [...readPermissions, "commerce:write", "chat:write"] as const;
const conversation = {
  id: "7494560109732334261",
  name: "Ayu",
  preview: "Apakah produk tersedia?",
  unread: 2,
  canReply: true,
  updatedAt: "2026-10-17T01:00:00Z",
};
const receipt = {
  id: "01JREQUEST0000000000000001",
  principalId: principal.id,
  kind: "conversations",
  status: "succeeded",
  conversations: [conversation],
  messages: [],
  nextCursor: null,
  messageId: null,
  errorMessage: null,
};
function setup(account = principal, sendStatus = "succeeded") {
  let next = 0;
  return mockApi({
    "GET /v1/commerce/principals": () => ({ items: [account] }),
    "GET /v1/commerce/operations": () => ({ items: [] }),
    "POST /v1/commerce-inbox/conversations/search": (call) => ({
      id: call.body && (call.body as { cursor?: string }).cursor ? "conversations-next" : receipt.id,
    }),
    [`GET /v1/commerce-inbox/requests/${receipt.id}`]: () => ({ ...receipt, nextCursor: "opaque-next" }),
    "GET /v1/commerce-inbox/requests/conversations-next": () => ({
      ...receipt,
      conversations: [{ ...conversation, id: "7494560109732334262", name: "Budi" }],
    }),
    "POST /v1/commerce-inbox/messages/search": () => ({ id: `messages-${++next}` }),
    "POST /v1/commerce-inbox/conversations": () => ({ id: "created-conversation" }),
    "GET /v1/commerce-inbox/requests/created-conversation": () => ({
      ...receipt,
      kind: "create",
      conversations: [],
      conversationId: conversation.id,
    }),
    "POST /v1/commerce-inbox/messages/send": () => ({ id: "send-receipt" }),
    "GET /v1/commerce-inbox/requests/send-receipt": () => ({
      ...receipt,
      kind: "send",
      status: sendStatus,
      conversations: [],
      messageId: "7494560109732334299",
    }),
    "GET /v1/commerce-inbox/requests/messages-1": () => ({
      ...receipt,
      kind: "messages",
      conversations: [],
      messages: [
        {
          id: "7494560109732334298",
          type: "TEXT",
          text: "Apakah produk tersedia?",
          sender: "Ayu",
          incoming: true,
          createdAt: "2026-10-17T01:00:00Z",
          mediaUrl: null,
        },
      ],
    }),
    "GET /v1/commerce-inbox/requests/messages-2": () => ({
      ...receipt,
      kind: "messages",
      conversations: [],
      messages: [],
    }),
  });
}
describe("marketplace inbox", () => {
  it("requires chat permission before requesting any marketplace data", () => {
    const calls = setup();
    renderApp(<CommerceInboxView />, { me: testMe(["commerce:read"]) });
    expect(screen.getByText(/Izin baca chat/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
  it("searches the loaded page, pages using opaque cursors, and never marks messages read implicitly", async () => {
    const calls = setup();
    const user = userEvent.setup();
    renderApp(<CommerceInboxView />, { me: testMe([...readPermissions]) });
    await screen.findByRole("button", { name: "Buka percakapan Ayu" });
    await user.type(screen.getByRole("searchbox"), "tidak-ada");
    expect(screen.getByText(/Tidak ada percakapan yang cocok/)).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox"));
    await user.click(screen.getByRole("button", { name: "Berikutnya" }));
    await screen.findByRole("button", { name: "Buka percakapan Budi" });
    expect(calls.find((call) => (call.body as { cursor?: string })?.cursor === "opaque-next")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Sebelumnya" }));
    await user.click(await screen.findByRole("button", { name: "Buka percakapan Ayu" }));
    const dialog = await screen.findByRole("dialog", { name: "Ayu" });
    await within(dialog).findByText("Apakah produk tersedia?");
    expect(calls.some((call) => call.path.endsWith("/messages/read"))).toBe(false);
    expect(within(dialog).queryByRole("button", { name: "Kirim balasan" })).not.toBeInTheDocument();
  });
  it("requires confirmation and sends a typed text reply with an idempotency key", async () => {
    const calls = setup();
    const user = userEvent.setup();
    renderApp(<CommerceInboxView />, { me: testMe([...writePermissions]) });
    await user.click(await screen.findByRole("button", { name: "Buka percakapan Ayu" }));
    await user.type(screen.getByLabelText("Tulis balasan"), "Halo, produk tersedia.");
    await user.click(screen.getByRole("button", { name: "Kirim balasan" }));
    expect(calls.some((call) => call.path.endsWith("/messages/send"))).toBe(false);
    const confirm = screen.getByRole("dialog", { name: "Kirim balasan ke pelanggan?" });
    await user.click(within(confirm).getByRole("button", { name: "Kirim balasan" }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith("/messages/send"))).toBe(true));
    const request = calls.find((call) => call.path.endsWith("/messages/send"));
    expect(request?.body).toEqual({
      principalId: principal.id,
      conversationId: conversation.id,
      type: "TEXT",
      text: "Halo, produk tersedia.",
    });
    expect(request?.headers?.["idempotency-key"]).toBeTruthy();
    await screen.findByText(/Marketplace menerima permintaan/);
  });
  it("locks uncertain replies and prompts checking the marketplace before resending", async () => {
    setup(principal, "uncertain");
    const user = userEvent.setup();
    renderApp(<CommerceInboxView />, { me: testMe([...writePermissions]) });
    await user.click(await screen.findByRole("button", { name: "Buka percakapan Ayu" }));
    await user.type(screen.getByLabelText("Tulis balasan"), "Halo");
    await user.click(screen.getByRole("button", { name: "Kirim balasan" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Kirim balasan ke pelanggan?" })).getByRole("button", {
        name: "Kirim balasan",
      }),
    );
    await screen.findByText(/Jawaban marketplace belum pasti/);
    expect(screen.getByRole("button", { name: "Kirim balasan" })).toBeDisabled();
  });
  it("explains unavailable Shopee chat without requesting marketplace messages", async () => {
    const calls = setup({ ...principal, channel: "shopee" });
    renderApp(<CommerceInboxView />, { me: testMe([...writePermissions]) });
    await screen.findByText(/Chat Shopee belum tersedia/);
    expect(calls.some((call) => call.path.startsWith("/v1/commerce-inbox/"))).toBe(false);
  });
  it("starts a conversation with the marketplace buyer user ID through a review modal", async () => {
    const calls = setup();
    const user = userEvent.setup();
    renderApp(<CommerceInboxView />, { me: testMe([...writePermissions]) });
    await user.click(await screen.findByRole("button", { name: "Percakapan baru" }));
    const dialog = screen.getByRole("dialog", { name: "Percakapan baru" });
    await user.type(within(dialog).getByLabelText("Nomor pengguna pembeli"), "7494560109732334262");
    expect(calls.some((call) => call.path === "/v1/commerce-inbox/conversations")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Mulai percakapan" }));
    await within(dialog).findByText(/Percakapan diterima marketplace/);
    expect(calls.find((call) => call.path === "/v1/commerce-inbox/conversations")?.body).toEqual({
      principalId: principal.id,
      buyerUserId: "7494560109732334262",
    });
  });
  it("opens read-only conversations without any write controls", async () => {
    const calls = setup({ ...principal, readOnly: true });
    const user = userEvent.setup();
    renderApp(<CommerceInboxView />, { me: testMe([...writePermissions]) });
    await user.click(await screen.findByRole("button", { name: "Buka percakapan Ayu" }));
    const dialog = screen.getByRole("dialog", { name: "Ayu" });
    expect(within(dialog).queryByRole("button", { name: "Kirim balasan" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Tandai dibaca" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Percakapan baru" })).not.toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith("/messages/send"))).toBe(false);
  });
});
