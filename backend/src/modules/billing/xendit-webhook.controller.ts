import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Controller, HttpCode, Inject, Injectable, Post, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { logger } from "@omniseller/logging";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { NotFoundError, UnauthorizedError } from "../../common/errors/domain-errors";
import { safeEqual } from "../../common/security/tokens";
import { ENV } from "../../config/config.module";
import type { DbHandle } from "../../db/client";
import { DB_TENANT, JOB_REGISTRY, QUEUES } from "../../infra/tokens";
import type { QueueRegistry } from "../../jobs/queues";
import type { JobRegistry } from "../../jobs/registry";

const log = logger.forModule("billing");
const ENQUEUE_TIMEOUT_MS = 2_000;

/**
 * Xendit's invoice callbacks (backend doc 8.32), on the webhook process. Xendit signs nothing: it sends
 * the account's Callback Verification Token in `x-callback-token`, and each delivery carries a unique
 * `webhook-id`. Verify, find the tenant through the SECURITY DEFINER lookup, enqueue, reply 200; a
 * reply other than 2xx makes Xendit retry up to six times over 24 hours, which is what a Redis outage
 * needs.
 */
@Injectable()
export class XenditWebhookService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(JOB_REGISTRY) private readonly registry: JobRegistry,
    @Inject(ENV) private readonly env: { XENDIT_WEBHOOK_TOKEN?: string | undefined },
  ) {}

  async receive(
    headers: Record<string, string | undefined>,
    rawBody: Buffer,
  ): Promise<"queued" | "unknown" | "ignored"> {
    const expected = this.env.XENDIT_WEBHOOK_TOKEN;
    if (!expected) throw new NotFoundError("billing.webhook_unavailable", "Pembayaran belum dikonfigurasi.");
    const token = headers["x-callback-token"] ?? "";
    if (!token || !safeEqual(token, expected)) {
      log.warn({ bytes: rawBody.length }, "xendit callback token rejected");
      throw new UnauthorizedError("webhook.signature_invalid", "Tanda tangan webhook tidak valid.");
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      return "ignored";
    }
    const externalId = typeof body.external_id === "string" ? body.external_id : "";
    const xenditId = typeof body.id === "string" ? body.id : "";
    const status = typeof body.status === "string" ? body.status : "";
    if (!externalId || !xenditId || !status) return "ignored";

    const r = await this.db.db.execute<{ tenant_id: string; invoice_id: string }>(
      sql`SELECT tenant_id, invoice_id FROM billing_resolve_invoice(${externalId})`,
    );
    const owner = r.rows[0];
    if (!owner) {
      // not an invoice of ours (another system on the same Xendit account): nothing to retry
      log.warn({ xendit_invoice_id: xenditId }, "xendit callback for an unknown invoice");
      return "unknown";
    }
    const webhookId = headers["webhook-id"] || createHash("sha256").update(rawBody).digest("base64url").slice(0, 32);
    const def = this.registry.get("billing", "billing.invoice_callback");
    if (!def) throw new Error("job billing/billing.invoice_callback is not registered");
    const payload = {
      tenantId: owner.tenant_id,
      invoiceId: owner.invoice_id,
      webhookId,
      xenditInvoiceId: xenditId,
      status,
      ...(typeof body.paid_at === "string" ? { paidAt: body.paid_at } : {}),
      ...(typeof body.paid_amount === "number" ? { paidAmount: body.paid_amount } : {}),
      ...(typeof body.payment_method === "string" ? { paymentMethod: body.payment_method } : {}),
      ...(typeof body.payment_channel === "string" ? { paymentChannel: body.payment_channel } : {}),
    };
    // the queue connection waits for Redis indefinitely; Xendit's retries are the buffer here
    await Promise.race([
      this.queues.get(def.queue).add(def.name, payload, { ...def.options, jobId: def.jobId(payload as never, {}) }),
      sleep(ENQUEUE_TIMEOUT_MS).then(() => {
        throw new Error("enqueue timed out");
      }),
    ]);
    return "queued";
  }
}

/** POST /webhooks/xendit on the webhook process; the body arrives as raw bytes (configureWebhookApp). */
@ApiExcludeController()
@Controller("webhooks/xendit")
export class XenditWebhookController {
  constructor(@Inject(XenditWebhookService) private readonly service: XenditWebhookService) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() req: Request): Promise<void> {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    await this.service.receive(headers, raw);
  }
}
