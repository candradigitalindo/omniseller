import { describe, expect, it, vi } from "vitest";
import { createTiktokShopConnector } from "./connector.js";

function harness(response: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(response), { status }));
  const connector = createTiktokShopConnector({
    appKey: "fixture",
    appSecret: "fixture",
    serviceId: "fixture",
    apiBaseUrl: "https://fixture.test",
    authBaseUrl: "https://fixture.test",
    authorizeUrl: "https://fixture.test",
    http: { fetch },
  });
  return { adapter: connector.commerce!, fetch };
}
const credentials = { accessToken: "fixture", externalShopId: "123" };
const setting = "tiktok_6656d987a0778602df27629e";
const invoice = "tiktok_67b542559a140004b343984f";
describe("generic commerce never promotes an unconfirmed TikTok mutation to accepted", () => {
  it("rejects a missing success envelope without repeating the mutation", async () => {
    const h = harness({});
    await expect(h.adapter.execute(credentials, setting, {})).rejects.toMatchObject({ code: "bad_response" });
    expect(h.fetch).toHaveBeenCalledOnce();
  });
  it("rejects success code0 on an unsuccessful HTTP response", async () => {
    const h = harness({ code: 0, data: {} }, 403);
    await expect(h.adapter.execute(credentials, setting, {})).rejects.toMatchObject({ code: "http_403" });
    expect(h.fetch).toHaveBeenCalledOnce();
  });
  it("rejects full or partial per-item refusal despite code0", async () => {
    const h = harness({
      code: 0,
      request_id: "fixture",
      data: { errors: [{ code: 12052032, message: "Every item failed" }] },
    });
    await expect(h.adapter.execute(credentials, invoice, {})).rejects.toMatchObject({
      code: "commerce_partial_failure",
    });
    expect(h.fetch).toHaveBeenCalledOnce();
  });
  it("accepts an explicit success with an empty documented failure list", async () => {
    const h = harness({ code: 0, request_id: "fixture", data: { errors: [] } });
    await expect(h.adapter.execute(credentials, invoice, {})).resolves.toMatchObject({
      data: { errors: [] },
      acknowledgement: "accepted",
    });
    expect(h.fetch).toHaveBeenCalledOnce();
  });
});
