import { logger } from "@omniseller/logging";
import { gatewayError, gatewayNotConfigured, XenditRefusedError } from "./billing.errors";

/**
 * Xendit's Invoice API (https://docs.xendit.co, "Create Invoice", POST /v2/invoices), the little this
 * module needs: a hosted payment page for one invoice, offering virtual accounts, QRIS, e-wallets,
 * cards, and retail outlets (technology doc ADR-020). Requests authenticate with HTTP Basic: the secret
 * API key as the user name and an empty password. Worker process only (backend doc 8.32).
 */
export interface XenditInvoiceInput {
  /** Our invoice id: Xendit sends it back in callbacks as `external_id`. */
  externalId: string;
  amount: number;
  payerEmail: string;
  payerName: string;
  description: string;
  durationSeconds: number;
  successRedirectUrl: string;
  failureRedirectUrl: string;
  items: { name: string; quantity: number; price: number }[];
  metadata: Record<string, string>;
}

export interface XenditInvoice {
  id: string;
  externalId: string;
  status: string;
  invoiceUrl: string;
  expiryDate: Date | null;
  amount: number;
}

export interface XenditEnv {
  XENDIT_SECRET_KEY?: string | undefined;
  XENDIT_API_BASE_URL: string;
}

const TIMEOUT_MS = 15_000;

export class XenditClient {
  private readonly log = logger.forModule("billing");

  constructor(private readonly env: XenditEnv) {}

  get configured(): boolean {
    return !!this.env.XENDIT_SECRET_KEY;
  }

  async createInvoice(input: XenditInvoiceInput): Promise<XenditInvoice> {
    const body = {
      external_id: input.externalId,
      amount: input.amount,
      currency: "IDR",
      payer_email: input.payerEmail,
      description: input.description,
      invoice_duration: input.durationSeconds,
      success_redirect_url: input.successRedirectUrl,
      failure_redirect_url: input.failureRedirectUrl,
      locale: "id",
      customer: { given_names: input.payerName, email: input.payerEmail },
      items: input.items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
      metadata: input.metadata,
    };
    const data = (await this.call("POST", "/v2/invoices", body)) as Record<string, unknown>;
    return readInvoice(data);
  }

  async getInvoice(id: string): Promise<XenditInvoice> {
    return readInvoice((await this.call("GET", `/v2/invoices/${encodeURIComponent(id)}`)) as Record<string, unknown>);
  }

  /** Closes an invoice's payment page (`POST /invoices/{id}/expire!`), so a withdrawn invoice takes no money. */
  async expireInvoice(id: string): Promise<void> {
    await this.call("POST", `/invoices/${encodeURIComponent(id)}/expire!`);
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const key = this.env.XENDIT_SECRET_KEY;
    if (!key) throw gatewayNotConfigured();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${this.env.XENDIT_API_BASE_URL}${path}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${key}:`, "utf8").toString("base64")}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        const err = (data ?? {}) as { error_code?: unknown; message?: unknown };
        // the error code is Xendit's catalogue (API_VALIDATION_ERROR, ...); the message may name the payer
        this.log.warn({ status: res.status, error_code: err.error_code, path }, "xendit refused");
        throw new XenditRefusedError(res.status, typeof err.error_code === "string" ? err.error_code : null);
      }
      return data;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError")
        throw gatewayError("Xendit tidak menjawab dalam 15 detik.");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function readInvoice(data: Record<string, unknown>): XenditInvoice {
  const str = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : "");
  if (!str("id") || !str("invoice_url")) throw gatewayError("Jawaban Xendit tidak lengkap.");
  const expiry = str("expiry_date");
  return {
    id: str("id"),
    externalId: str("external_id"),
    status: str("status"),
    invoiceUrl: str("invoice_url"),
    expiryDate: expiry && !Number.isNaN(Date.parse(expiry)) ? new Date(expiry) : null,
    amount: typeof data.amount === "number" ? data.amount : 0,
  };
}
