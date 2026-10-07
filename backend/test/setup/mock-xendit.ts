import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake of Xendit's Invoice API as documented (POST /v2/invoices, GET /v2/invoices/{id},
 * POST /invoices/{id}/expire!): checks the Basic auth header, keeps the invoices it made, and gives each a
 * payment page URL. A test "pays" an invoice by posting the documented callback to the webhook process
 * itself (`callbackFor`); an expired invoice can still be "paid" that way, as a transfer in flight would.
 */
export const XENDIT_TEST_KEY = "xnd_development_test_key_000000";
export const XENDIT_TEST_TOKEN = "callback-verification-token-test";

export interface MockXenditInvoice {
  id: string;
  externalId: string;
  amount: number;
  status: "PENDING" | "PAID" | "EXPIRED";
  payerEmail: string | null;
  description: string | null;
  body: Record<string, unknown>;
}

export class MockXendit {
  url = "";
  readonly invoices = new Map<string, MockXenditInvoice>();
  readonly calls: { method: string; path: string; auth: string | undefined }[] = [];
  /** Runs while an invoice is being created, before Xendit answers (a seller acting meanwhile). */
  beforeCreate: (() => Promise<unknown>) | null = null;
  /** The next create fails with this status and body. */
  private failNextWith: { status: number; body: unknown } | null = null;
  private server: Server | undefined;
  private seq = 0;

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  failNext(status: number, body: unknown): void {
    this.failNextWith = { status, body };
  }

  /** The invoice Xendit holds for one of ours (`external_id`). */
  byExternalId(externalId: string): MockXenditInvoice | undefined {
    return [...this.invoices.values()].find((i) => i.externalId === externalId);
  }

  /** Invoices whose page was closed through the API, by Xendit id. */
  readonly expired = new Set<string>();

  /** The callback body Xendit would send once this invoice is paid (or expired), as documented. */
  callbackFor(
    externalId: string,
    status: "PAID" | "EXPIRED" | "SETTLED",
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const inv = this.byExternalId(externalId);
    if (!inv) throw new Error(`mock xendit: no invoice for ${externalId}`);
    inv.status = status === "EXPIRED" ? "EXPIRED" : "PAID";
    const paid = status !== "EXPIRED";
    const at = new Date().toISOString();
    return {
      id: inv.id,
      external_id: inv.externalId,
      user_id: "5f1f2a3b4c5d6e7f8a9b0c1d",
      is_high: false,
      status,
      merchant_name: "OmniSeller",
      amount: inv.amount,
      ...(paid
        ? {
            paid_amount: inv.amount,
            paid_at: at,
            payment_method: "BANK_TRANSFER",
            payment_channel: "BCA",
            payment_destination: "1234567890",
            bank_code: "BCA",
          }
        : {}),
      payer_email: inv.payerEmail,
      description: inv.description,
      currency: "IDR",
      created: at,
      updated: at,
      ...over,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const path = (req.url ?? "/").split("?")[0]!;
    const auth = req.headers.authorization;
    this.calls.push({ method: req.method ?? "", path, auth });
    const expected = `Basic ${Buffer.from(`${XENDIT_TEST_KEY}:`).toString("base64")}`;
    if (auth !== expected) return send(res, 401, { error_code: "API_VALIDATION_ERROR", message: "Invalid API key" });

    if (req.method === "POST" && path === "/v2/invoices") {
      if (this.failNextWith) {
        const f = this.failNextWith;
        this.failNextWith = null;
        return send(res, f.status, f.body);
      }
      if (this.beforeCreate) {
        const hook = this.beforeCreate;
        this.beforeCreate = null;
        await hook();
      }
      const body = JSON.parse(text) as Record<string, unknown>;
      if (typeof body.external_id !== "string" || typeof body.amount !== "number" || body.amount < 10_000) {
        return send(res, 400, { error_code: "API_VALIDATION_ERROR", message: "external_id and amount are required" });
      }
      const existing = this.byExternalId(body.external_id);
      if (existing) return send(res, 400, { error_code: "DUPLICATE_ERROR", message: "external_id already exists" });
      this.seq += 1;
      const inv: MockXenditInvoice = {
        id: `mockinv${String(this.seq).padStart(20, "0")}`,
        externalId: body.external_id,
        amount: body.amount,
        status: "PENDING",
        payerEmail: typeof body.payer_email === "string" ? body.payer_email : null,
        description: typeof body.description === "string" ? body.description : null,
        body,
      };
      this.invoices.set(inv.id, inv);
      const duration = typeof body.invoice_duration === "number" ? body.invoice_duration : 86_400;
      return send(res, 200, this.view(inv, duration));
    }
    const ex = /^\/invoices\/([^/]+)\/expire!$/.exec(path);
    if (req.method === "POST" && ex) {
      const inv = this.invoices.get(decodeURIComponent(ex[1]!));
      if (!inv) return send(res, 404, { error_code: "INVOICE_NOT_FOUND_ERROR", message: "not found" });
      if (inv.status === "PAID") return send(res, 400, { error_code: "INVOICE_ALREADY_PAID_ERROR", message: "paid" });
      inv.status = "EXPIRED";
      this.expired.add(inv.id);
      return send(res, 200, this.view(inv, 0));
    }
    const m = /^\/v2\/invoices\/([^/]+)$/.exec(path);
    if (req.method === "GET" && m) {
      const inv = this.invoices.get(decodeURIComponent(m[1]!));
      if (!inv) return send(res, 404, { error_code: "INVOICE_NOT_FOUND_ERROR", message: "not found" });
      return send(res, 200, this.view(inv, 86_400));
    }
    send(res, 404, { error_code: "NOT_FOUND", message: `no route ${req.method} ${path}` });
  }

  private view(inv: MockXenditInvoice, duration: number): Record<string, unknown> {
    return {
      id: inv.id,
      external_id: inv.externalId,
      user_id: "5f1f2a3b4c5d6e7f8a9b0c1d",
      status: inv.status,
      merchant_name: "OmniSeller",
      amount: inv.amount,
      payer_email: inv.payerEmail,
      description: inv.description,
      invoice_url: `${this.url}/web/invoices/${inv.id}`,
      expiry_date: new Date(Date.now() + duration * 1000).toISOString(),
      available_banks: [{ bank_code: "BCA", collection_type: "POOL", transfer_amount: inv.amount }],
      available_ewallets: [{ ewallet_type: "OVO" }, { ewallet_type: "DANA" }],
      available_qr_codes: [{ qr_code_type: "QRIS" }],
      available_retail_outlets: [{ retail_outlet_name: "ALFAMART" }],
      should_exclude_credit_card: false,
      should_send_email: false,
      created: "2026-10-07T10:00:00.000Z",
      updated: "2026-10-07T10:00:00.000Z",
      currency: "IDR",
    };
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
