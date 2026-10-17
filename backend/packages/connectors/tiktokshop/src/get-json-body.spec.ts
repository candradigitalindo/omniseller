import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { TiktokShopClient, tiktokSign, tiktokSignString } from "./client.js";
import { mappingGetBodyFetch, TIKTOK_MAPPING_GET_PATH } from "./get-json-body.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("documented TikTok GET JSON body transport", () => {
  it("sends exact signed GET body bytes through Node HTTP without following redirects", async () => {
    const calls: { method: string; path: string; body: string; token: string | undefined }[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({
        method: req.method!,
        path: req.url!,
        body: Buffer.concat(chunks).toString(),
        token: req.headers["x-tts-access-token"] as string | undefined,
      });
      res.setHeader("content-type", "application/json");
      res.end('{"code":0,"data":{"product":[{"toko_pid":9223372036854775806,"tts_pid":9223372036854775807}]}}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback fixture");
    const origin = `http://127.0.0.1:${address.port}`;
    const body = { toko_pids: [42] };
    const client = new TiktokShopClient({
      appKey: "app",
      appSecret: "secret",
      apiBaseUrl: origin,
      authBaseUrl: origin,
      authorizeUrl: origin,
    });
    const result = await client.call({ method: "GET", path: TIKTOK_MAPPING_GET_PATH, accessToken: "PRIVATE", body });
    expect(result).toEqual({ product: [{ toko_pid: "9223372036854775806", tts_pid: "9223372036854775807" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", body: JSON.stringify(body), token: "PRIVATE" });
    const url = new URL(calls[0]!.path, origin);
    const query = Object.fromEntries(url.searchParams);
    expect(query.sign).toBe(
      tiktokSign("secret", tiktokSignString({ path: url.pathname, query, body: calls[0]!.body })),
    );
  });

  it("rejects every unreviewed origin/path/method before a configured transport is called", async () => {
    let calls = 0;
    const send = mappingGetBodyFetch("https://open-api.tiktokglobalshop.com", (async () => {
      calls++;
      return Response.json({});
    }) as typeof fetch);
    for (const [url, method] of [
      [`https://evil.invalid${TIKTOK_MAPPING_GET_PATH}`, "GET"],
      [`https://open-api.tiktokglobalshop.com${TIKTOK_MAPPING_GET_PATH}/other`, "GET"],
      [`https://open-api.tiktokglobalshop.com${TIKTOK_MAPPING_GET_PATH}`, "POST"],
      [`http://open-api.tiktokglobalshop.com${TIKTOK_MAPPING_GET_PATH}`, "GET"],
      [`https://user:password@open-api.tiktokglobalshop.com${TIKTOK_MAPPING_GET_PATH}`, "GET"],
    ])
      await expect(send(url!, { method, body: "{}" })).rejects.toMatchObject({ code: "get_body_contract_unverified" });
    expect(calls).toBe(0);
  });

  it("does not follow HTTP redirects or forward the creator token to their destination", async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(new URL(req.url!, "http://fixture").pathname);
      req.resume();
      res.statusCode = 302;
      res.setHeader("location", "/unreviewed-destination");
      res.setHeader("content-type", "application/json");
      res.end('{"code":0,"data":{}}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback fixture");
    const origin = `http://127.0.0.1:${address.port}`;
    const client = new TiktokShopClient({
      appKey: "app",
      appSecret: "secret",
      apiBaseUrl: origin,
      authBaseUrl: origin,
      authorizeUrl: origin,
    });
    await expect(
      client.call({ method: "GET", path: TIKTOK_MAPPING_GET_PATH, accessToken: "PRIVATE", body: { toko_pids: [42] } }),
    ).rejects.toMatchObject({ code: "http_302" });
    expect(paths).toEqual([TIKTOK_MAPPING_GET_PATH]);
  });

  it("refuses GET JSON bodies on other API contracts", async () => {
    const client = new TiktokShopClient({
      appKey: "app",
      appSecret: "secret",
      apiBaseUrl: "https://open-api.tiktokglobalshop.com",
      authBaseUrl: "https://auth.tiktok-shops.com",
      authorizeUrl: "https://services.tiktokshop.com/open/authorize",
    });
    await expect(
      client.call({ method: "GET", path: "/affiliate_creator/202508/profiles", accessToken: "secret", body: {} }),
    ).rejects.toMatchObject({ code: "get_body_contract_unverified" });
  });
});
