import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { PermanentConnectorError } from "@omniseller/connector-core";

export const TIKTOK_MAPPING_GET_PATH = "/affiliate_creator/202606/toko_product_mappers";

/**
 * The official mapping API and generated SDKs require GET with a signed JSON body. Fetch refuses
 * GET bodies. Keep this Node transport restricted to that exact contract; all other API calls use
 * the standard fetch path. requestJson still owns timeout, limits, rate gating and the observer.
 */
export function mappingGetBodyFetch(apiBaseUrl: string, testTransport?: typeof fetch): typeof fetch {
  const base = new URL(apiBaseUrl);
  return (async (input, init) => {
    const url = new URL(String(input));
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      init?.method !== "GET" ||
      url.origin !== base.origin ||
      url.pathname !== TIKTOK_MAPPING_GET_PATH ||
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      typeof init.body !== "string" ||
      Buffer.byteLength(init.body) > 65_536
    )
      throw new PermanentConnectorError({
        code: "get_body_contract_unverified",
        message: "Unreviewed GET body transport",
      });
    if (testTransport) return testTransport(input, init);
    const headers = Object.fromEntries(new Headers(init.headers));
    headers["content-length"] = String(Buffer.byteLength(init.body));
    headers["accept-encoding"] = "identity";
    return new Promise<Response>((resolve, reject) => {
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        { method: "GET", headers, ...(init.signal ? { signal: init.signal } : {}) },
        (res) => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) for (const entry of value) responseHeaders.append(name, entry);
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
            res.destroy();
            reject(new Error("Unexpected compressed mapping response"));
            return;
          }
          const status = res.statusCode ?? 502;
          // Never follow a Location header or forward an authorization token to another endpoint.
          const noBody = [204, 205, 304].includes(status);
          if (noBody) res.resume();
          resolve(
            new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
              status,
              headers: responseHeaders,
            }),
          );
        },
      );
      req.once("error", reject);
      req.end(init.body);
    });
  }) as typeof fetch;
}
