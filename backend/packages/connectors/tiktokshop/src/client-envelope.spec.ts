import { describe, expect, it, vi } from "vitest";
import { TiktokShopClient } from "./client.js";

function harness(body: string, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, { status }));
  const client = new TiktokShopClient({
    appKey: "fixture",
    appSecret: "fixture",
    serviceId: "fixture",
    apiBaseUrl: "https://fixture.test",
    authBaseUrl: "https://fixture.test",
    authorizeUrl: "https://fixture.test",
    http: { fetch },
  });
  return { client, fetch };
}
describe("TikTok transport requires an explicit documented success envelope", () => {
  it.each(["{}", '{"code":"0"}', '{"code":null}', '{"code":false}', '{"code":0.5}', "[]", "null"])(
    "refuses malformed success %s",
    async (body) => {
      const h = harness(body);
      await expect(
        h.client.call({ method: "POST", path: "/fixture", accessToken: "fixture", body: {} }),
      ).rejects.toMatchObject({ kind: "permanent", code: "bad_response" });
      expect(h.fetch).toHaveBeenCalledOnce();
    },
  );
  it.each([302, 400, 401, 403, 404, 429, 500])("refuses success code0 with HTTP%d", async (status) => {
    const h = harness('{"code":0,"data":{}}', status);
    await expect(
      h.client.call({ method: "POST", path: "/fixture", accessToken: "fixture", body: {} }),
    ).rejects.toMatchObject({ code: `http_${status}`, httpStatus: status });
    expect(h.fetch).toHaveBeenCalledOnce();
  });
  it.each([429, 503])("preserves a transient HTTP%d refusal with malformed JSON envelope", async (status) => {
    const h = harness("{}", status);
    await expect(h.client.call({ method: "GET", path: "/fixture", accessToken: "fixture" })).rejects.toMatchObject({
      kind: "transient",
      code: `http_${status}`,
      httpStatus: status,
    });
    expect(h.fetch).toHaveBeenCalledOnce();
  });
  it("accepts explicit numeric zero only on a successful HTTP response", async () => {
    const h = harness('{"code":0,"request_id":"fixture","data":{"accepted":true}}');
    await expect(
      h.client.call({ method: "POST", path: "/fixture", accessToken: "fixture", body: {} }),
    ).resolves.toEqual({ accepted: true });
    expect(h.fetch).toHaveBeenCalledOnce();
  });
  it("applies the same contract to token and multipart responses", async () => {
    const h = harness("{}");
    await expect(h.client.token("/api/v2/token/get", { code: "fixture" })).rejects.toMatchObject({
      code: "bad_response",
    });
    await expect(
      h.client.upload({
        path: "/product/202309/images/upload",
        accessToken: "fixture",
        form: { body: new FormData(), logBody: { media: true } },
      }),
    ).rejects.toMatchObject({ code: "bad_response" });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it("preserves explicit authorization and permission refusals", async () => {
    const h = harness('{"code":105005,"request_id":"fixture","message":"Permission denied","data":{}}', 403);
    await expect(
      h.client.call({ method: "POST", path: "/fixture", accessToken: "fixture", body: {} }),
    ).rejects.toMatchObject({ kind: "permanent", code: "105005" });
    const expired = harness('{"code":105002,"message":"Token expired","data":{}}');
    await expect(
      expired.client.call({ method: "GET", path: "/fixture", accessToken: "fixture" }),
    ).rejects.toMatchObject({ kind: "auth_expired", code: "105002" });
  });
});
