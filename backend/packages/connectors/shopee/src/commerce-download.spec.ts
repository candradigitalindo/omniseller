import { type CallRecord, parseJsonSafe } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { ShopeeClient } from "./client.js";
import { shopeeCommerce } from "./commerce.js";

const credentials = { externalShopId: "9007199254740993", accessToken: "test-token" };
const pdfText = "%PDF-1.4\nPII-canary-do-not-log-label-content\n%%EOF";
const pdf = () => new Response(pdfText, { headers: { "content-type": "application/pdf" } });
const jobId = "shopee.logistics.download_shipping_document_job";
const jobInput = { body: { job_id: "JOB-ONE" } };
function harness(reply: (url: URL, init: RequestInit, index: number) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const records: CallRecord[] = [];
  let pacing = 0;
  const api = shopeeCommerce(
    new ShopeeClient({
      partnerId: 123,
      partnerKey: "test-key",
      apiBaseUrl: "https://partner.shopeemobile.com",
      authBaseUrl: "https://open.shopee.com",
      http: {
        beforeRequest: async () => {
          pacing++;
        },
        observer: (record) => records.push(record),
        fetch: (async (input, init = {}) => {
          const url = new URL(String(input));
          calls.push({ url, init });
          return reply(url, init, calls.length - 1);
        }) as typeof fetch,
      },
    }),
  );
  return { api, calls, records, pacing: () => pacing };
}

describe("Shopee private commerce document downloads", () => {
  it("downloads documented booking and job PDFs as private bytes with only metadata in receipts/logs", async () => {
    const h = harness(() => pdf());
    const booking = await h.api.execute(credentials, "shopee.logistics.download_booking_shipping_document", {
      body: { shipping_document_type: "NORMAL_AIR_WAYBILL", booking_list: [{ booking_sn: "BOOKING" }] },
    });
    const job = await h.api.execute(credentials, jobId, jobInput);
    expect(booking.download).toMatchObject({ mime: "application/pdf", ext: "pdf" });
    expect(job.download?.bytes).toEqual(new TextEncoder().encode(pdfText));
    expect(job.data).toEqual({ mime: "application/pdf", sizeBytes: new TextEncoder().encode(pdfText).length });
    expect(h.calls.map((call) => call.url.pathname)).toEqual([
      "/api/v2/logistics/download_booking_shipping_document",
      "/api/v2/logistics/download_shipping_document_job",
    ]);
    expect(parseJsonSafe(String(h.calls[0]?.init.body))).toEqual({
      shipping_document_type: "NORMAL_AIR_WAYBILL",
      booking_list: [{ booking_sn: "BOOKING" }],
    });
    expect(h.calls.every((call) => call.init.redirect === "manual")).toBe(true);
    expect(JSON.stringify(h.records)).not.toContain("PII-canary");
    expect(JSON.stringify(job.data)).not.toContain("PII-canary");
    expect(h.records.every((record) => !record.path.includes("?"))).toBe(true);
  });

  it("follows only bounded redirects within the configured API origin and paces every request", async () => {
    const h = harness((_url, _init, index) =>
      index === 0 ? new Response(null, { status: 303, headers: { location: "/private/document" } }) : pdf(),
    );
    expect((await h.api.execute(credentials, jobId, jobInput)).download?.mime).toBe("application/pdf");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.url.origin).toBe("https://partner.shopeemobile.com");
    expect(h.calls[1]?.init.method).toBe("GET");
    expect(h.calls[1]?.init.body).toBeUndefined();
    expect(h.pacing()).toBe(2);
  });

  it.each([
    "https://evil.example/private.pdf",
    "//evil.example/private.pdf",
    "http://partner.shopeemobile.com/private.pdf",
    "https://user:password@partner.shopeemobile.com/private.pdf",
    "file:///etc/passwd",
  ])("refuses untrusted redirect %s before another request", async (location) => {
    const h = harness(() => new Response(null, { status: 302, headers: { location } }));
    await expect(h.api.execute(credentials, jobId, jobInput)).rejects.toMatchObject({
      code: "commerce_untrusted_redirect",
      kind: "permanent",
    });
    expect(h.calls).toHaveLength(1);
    expect(JSON.stringify(h.records)).not.toContain(location);
  });

  it("stops redirect loops after three redirects", async () => {
    const h = harness(() => new Response(null, { status: 307, headers: { location: "/again" } }));
    await expect(h.api.execute(credentials, jobId, jobInput)).rejects.toMatchObject({
      code: "commerce_redirect_limit",
    });
    expect(h.calls).toHaveLength(4);
  });

  it.each([
    () => new Response("<html>PII-canary</html>", { headers: { "content-type": "application/pdf" } }),
    () => new Response(pdfText, { headers: { "content-type": "text/html" } }),
  ])("rejects invalid file content or MIME %#", async (reply) => {
    const h = harness(reply);
    await expect(h.api.execute(credentials, jobId, jobInput)).rejects.toMatchObject({ code: "commerce_file_type" });
    expect(JSON.stringify(h.records)).not.toContain("PII-canary");
  });

  it("never follows a JSON file link and refuses an oversized declared response", async () => {
    const linked = harness(
      () =>
        new Response(JSON.stringify({ response: { file_link: "http://169.254.169.254/latest/meta-data" } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(linked.api.execute(credentials, jobId, jobInput)).rejects.toMatchObject({ code: "no_file" });
    expect(linked.calls).toHaveLength(1);
    expect(JSON.stringify(linked.records)).not.toContain("169.254.169.254");
    const large = harness(
      () =>
        new Response(pdfText, {
          headers: { "content-type": "application/pdf", "content-length": String(21 * 1024 * 1024) },
        }),
    );
    await expect(large.api.execute(credentials, jobId, jobInput)).rejects.toMatchObject({
      code: "commerce_file_too_large",
    });
  });

  it("keeps region-restricted, unverified-link and existing label APIs unavailable to this generic consumer", async () => {
    const h = harness(() => pdf());
    for (const operation of [
      "logistics.download_to_label",
      "order.download_invoice_doc",
      "order.upload_invoice_doc",
      "logistics.upload_serviceable_polygon",
      "order.download_fbs_invoices",
      "logistics.download_shipping_document",
    ]) {
      await expect(h.api.execute(credentials, `shopee.${operation}`, {})).rejects.toMatchObject({
        code: "commerce_unavailable",
      });
    }
    expect(h.calls).toHaveLength(0);
  });
});
