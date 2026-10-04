import { Inject, Injectable } from "@nestjs/common";
import { isConnectorError, type NormalizedReturn, type UploadedEvidence } from "@omniseller/connector-core";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { withStatusSource, withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import type { StoreRow } from "../channel/channel.repository";
import { MarketplaceGateway } from "../channel/marketplace-gateway";
import { isManualChannel, StoresService } from "../channel/stores.service";
import { FilesService } from "../files/files.service";
import { OrderSyncService } from "../orders/order-sync.service";
import { OrdersService } from "../orders/orders.service";
import { describeSyncError } from "../sync/connector-calls";
import { SyncLogService } from "../sync/sync-log.service";
import { FINAL_STATUSES, itemsChanged, matchItems, nextStatus, type OrderLine, rtoItems } from "./return-plan";
import { returnDetailsRequested, returnPullRequested } from "./returns.events";
import { type ReturnRow, ReturnsRepository } from "./returns.repository";

const log = logger.forModule("returns.sync");

/** Pages per job; a long range continues in a new job (`return.pull_requested`). */
export const RETURN_PAGES_PER_JOB = 5;
/** A store's first pull reads requests changed this far back: older ones are long decided. */
export const RETURN_INITIAL_DAYS = 30;
/** Pulls look back a little before the last one started, to cover clock skew. */
const OVERLAP_MS = 10 * 60_000;
/** Requests whose decisions are read per job; more continue in a `return.details` job. */
const DETAILS_PER_RUN = 50;
/** A job's claim on the requests it reads; a claim this old belongs to a job that stopped. */
const DETAILS_LEASE_MS = 5 * 60_000;
/** Open cancellation requests read again per pull. */
const OPEN_CANCELLATIONS = 50;
const USABLE = new Set(["active", "token_expiring"]);

export interface ReturnPullInput {
  storeId: string;
  cursor?: string | undefined;
  startedAt?: string | undefined;
  from?: string | undefined;
  /** The store's first pull: what it reads is history and is not announced. */
  initial?: boolean | undefined;
  /** Asked for because an order changed at this time (`order.return_started`). */
  at?: string | undefined;
}

type Outcome = "created" | "updated" | "stale" | "ignored";

const orderLine = (i: {
  id: string;
  externalProductId: string | null;
  externalSkuId: string | null;
  skuSnapshot: string;
  titleSnapshot: string;
  qty: number;
  cancelledQty: number;
  shippedQty: number;
  returnedQty: number;
}): OrderLine => ({
  id: i.id,
  externalProductId: i.externalProductId,
  externalSkuId: i.externalSkuId,
  skuSnapshot: i.skuSnapshot,
  titleSnapshot: i.titleSnapshot,
  qty: i.qty,
  cancelledQty: i.cancelledQty,
  shippedQty: i.shippedQty,
  returnedQty: i.returnedQty,
});

/**
 * Worker side of returns (PRD FR-RET-01, 02, 06; backend doc 8.26): reads requests from the marketplaces
 * through MarketplaceGateway (every 10 minutes, on webhooks, when an order says a return started, when
 * the buyer asks to cancel), applies each snapshot in its own short transaction, reads what the seller
 * may decide, sends the seller's decisions, and opens a returning parcel (rto) for orders cancelled after
 * they shipped. No transaction stays open across a marketplace call.
 */
@Injectable()
export class ReturnSyncService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ReturnsRepository) private readonly repo: ReturnsRepository,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(OrderSyncService) private readonly orderSync: OrderSyncService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(MarketplaceGateway) private readonly gateway: MarketplaceGateway,
    @Inject(SyncLogService) private readonly syncLog: SyncLogService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  /** The store, when it can be asked about returns: connected, and a marketplace (not a manual channel). */
  private async usable(ctx: RequestContext, storeId: string): Promise<StoreRow | null> {
    const store = await withTenantTx(this.db, ctx, (tx) => this.stores.rowIn(tx, storeId));
    return store && USABLE.has(store.status) && !isManualChannel(store.channel) ? store : null;
  }

  /**
   * Requests updated since the last pull (the first pull: 30 days), page by page; then open cancellation
   * requests are read again and the decisions of changed requests are read.
   */
  async pull(ctx: RequestContext, input: ReturnPullInput, queueJobId?: string): Promise<{ done: boolean } | null> {
    const store = await this.usable(ctx, input.storeId);
    if (!store) {
      await this.syncLog.skipped(
        ctx,
        { storeId: input.storeId, kind: "returns.pull", direction: "pull" },
        "Toko tidak terhubung.",
      );
      return null;
    }
    const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
    let from = input.from ? new Date(input.from) : null;
    let initial = input.initial === true;
    if (!from) {
      const last = await this.stores.syncCursor(ctx, store.id, "returns");
      // a burst of orders entering TO_RETURN asks many times: a pull that started after the order
      // changed has read its request already (the marketplace writes the return before the order)
      if (input.at && last && new Date(last) >= new Date(input.at)) return { done: true };
      if (last) from = new Date(new Date(last).getTime() - OVERLAP_MS);
      else {
        from = new Date(startedAt.getTime() - RETURN_INITIAL_DAYS * 86_400_000);
        initial = true;
      }
    }
    const job = queueJobId ? { queueJobId } : {};
    let cursor: string | null = input.cursor ?? null;
    for (let pages = 0; pages < RETURN_PAGES_PER_JOB; pages++) {
      const page = await this.gateway.call(
        ctx,
        store.id,
        {
          kind: "returns.pull",
          direction: "pull",
          request: { from: from.toISOString(), cursor: cursor ? "…" : null },
          ...job,
        },
        (connector, shop) => connector.returns.listReturns(shop, { from: from!, to: startedAt, cursor }),
        (p) => ({ returns: p.returns.length, more: p.nextCursor !== null }),
      );
      await this.applyAll(ctx, store, page.returns, { announce: !initial });
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    if (cursor) {
      await withTenantTx(this.db, ctx, (tx) =>
        this.outbox.enqueue(
          tx,
          ctx,
          returnPullRequested,
          { storeId: store.id, cursor, startedAt: startedAt.toISOString(), from: from!.toISOString(), initial },
          store.id,
        ),
      );
      return { done: false };
    }
    await this.stores.saveSyncCursor(ctx, store.id, "returns", startedAt.toISOString());
    await this.refreshOpenCancellations(ctx, store, queueJobId);
    await this.readDecisions(ctx, store, queueJobId);
    return { done: true };
  }

  /** Specific return requests read again (TikTok Shop return status webhook). */
  async refreshReturns(ctx: RequestContext, storeId: string, externalReturnIds: string[], queueJobId?: string) {
    const ids = [...new Set(externalReturnIds.filter(Boolean))];
    const store = ids.length > 0 ? await this.usable(ctx, storeId) : null;
    if (!store) return;
    const snaps = await this.gateway.call(
      ctx,
      store.id,
      {
        kind: "returns.refresh",
        direction: "pull",
        request: { returns: ids.length },
        ...(queueJobId ? { queueJobId } : {}),
      },
      (connector, shop) => connector.returns.getReturns(shop, ids),
      (r) => ({ returns: r.length }),
    );
    await this.applyAll(ctx, store, snaps, { announce: true });
    await this.readDecisions(ctx, store, queueJobId);
  }

  /** The buyers' cancellation requests of these orders read again (the order's flag changed). */
  async followCancellations(ctx: RequestContext, storeId: string, orderIds: string[], queueJobId?: string) {
    const store = await this.usable(ctx, storeId);
    if (!store) return;
    const refs = await withTenantTx(this.db, ctx, (tx) => this.orders.refsIn(tx, orderIds));
    const external = [...refs.values()].filter((r) => r.storeId === store.id).map((r) => r.externalOrderId);
    if (external.length === 0) return;
    await this.readCancellations(ctx, store, external, queueJobId);
    await this.readDecisions(ctx, store, queueJobId);
  }

  /** One request read again with its decisions (the seller asked, or after a decision was sent). */
  async refreshRequest(ctx: RequestContext, id: string, queueJobId?: string): Promise<void> {
    const row = await withTenantTx(this.db, ctx, (tx) => this.repo.get(tx, id));
    if (!row || row.kind === "rto") return;
    const store = await this.usable(ctx, row.storeId);
    if (!store) return;
    if (row.kind === "cancellation") {
      const refs = await withTenantTx(this.db, ctx, (tx) => this.orders.refsIn(tx, [row.orderId]));
      const ext = refs.get(row.orderId)?.externalOrderId;
      if (ext) await this.readCancellations(ctx, store, [ext], queueJobId);
    } else {
      const snaps = await this.gateway.call(
        ctx,
        store.id,
        { kind: "returns.refresh", direction: "pull", request: { returns: 1 }, ...(queueJobId ? { queueJobId } : {}) },
        (connector, shop) => connector.returns.getReturns(shop, [row.externalReturnId!]),
        (r) => ({ returns: r.length }),
      );
      await this.applyAll(ctx, store, snaps, { announce: true });
    }
    const fresh = await withTenantTx(this.db, ctx, (tx) => this.repo.get(tx, id));
    if (fresh && !FINAL_STATUSES.has(fresh.status)) await this.readDetailsOf(ctx, store, [fresh], queueJobId);
  }

  private async readCancellations(
    ctx: RequestContext,
    store: StoreRow,
    externalOrderIds: string[],
    queueJobId?: string,
  ) {
    const snaps = await this.gateway.call(
      ctx,
      store.id,
      {
        kind: "returns.cancellations",
        direction: "pull",
        request: { orders: externalOrderIds.length },
        ...(queueJobId ? { queueJobId } : {}),
      },
      (connector, shop) => connector.returns.cancellations(shop, externalOrderIds),
      (r) => ({ requests: r.length }),
    );
    await this.applyAll(ctx, store, snaps, { announce: true });
  }

  /** Open cancellation requests may end without a notification (the buyer withdrew in the app). */
  private async refreshOpenCancellations(ctx: RequestContext, store: StoreRow, queueJobId?: string) {
    const ids = await withTenantTx(this.db, ctx, async (tx) => {
      const open = await this.repo.openCancellations(tx, store.id, OPEN_CANCELLATIONS);
      const refs = await this.orders.refsIn(
        tx,
        open.map((r) => r.orderId),
      );
      return [...new Set(open.map((r) => refs.get(r.orderId)?.externalOrderId).filter((x): x is string => !!x))];
    });
    if (ids.length > 0) await this.readCancellations(ctx, store, ids, queueJobId);
  }

  /**
   * Applies snapshots one transaction each. Requests of orders OmniSeller has not read yet (older than
   * the order import) bring their orders in first.
   */
  async applyAll(
    ctx: RequestContext,
    store: StoreRow,
    snaps: NormalizedReturn[],
    opts: { announce: boolean },
  ): Promise<Record<Outcome, number>> {
    const outcome: Record<Outcome, number> = { created: 0, updated: 0, stale: 0, ignored: 0 };
    if (snaps.length === 0) return outcome;
    const known = await withTenantTx(this.db, ctx, (tx) =>
      this.orders.idMapByExternalIn(
        tx,
        store.id,
        snaps.map((s) => s.externalOrderId),
      ),
    );
    const unknown = [...new Set(snaps.map((s) => s.externalOrderId).filter((id) => id && !known.has(id)))];
    if (unknown.length > 0) await this.orderSync.refresh(ctx, store.id, unknown, { source: "poll" });
    for (const snap of snaps) {
      const result = await withTenantTx(this.db, ctx, (tx) => this.applyIn(tx, ctx, store, snap, opts.announce));
      outcome[result]++;
    }
    if (outcome.created + outcome.updated > 0) log.info({ store_id: store.id, ...outcome }, "return requests applied");
    return outcome;
  }

  private async applyIn(
    tx: Tx,
    ctx: RequestContext,
    store: StoreRow,
    snap: NormalizedReturn,
    announce: boolean,
  ): Promise<Outcome> {
    const cancellation = snap.kind === "cancellation";
    const existing = (await this.repo.byExternal(tx, store.id, cancellation, [snap.externalReturnId], true)).get(
      snap.externalReturnId,
    );
    const orderId = (await this.orders.idMapByExternalIn(tx, store.id, [snap.externalOrderId])).get(
      snap.externalOrderId,
    );
    if (!orderId) return "ignored";
    const { orders, items } = await this.orders.readIn(tx, [orderId]);
    const o = orders[0];
    if (!o) return "ignored";
    const planned = matchItems(items.map(orderLine), snap.items);
    const fields = {
      externalStatus: snap.externalStatus,
      initiator: snap.initiator,
      reasonCode: snap.reasonCode,
      reason: snap.reason,
      refundAmount: snap.refundAmount,
      currency: snap.currency.slice(0, 3),
      respondByAt: snap.respondBy,
      sellerAction: snap.sellerAction,
      // goods of an order a marketplace warehouse fulfilled go back to that warehouse
      goodsReturn: snap.goodsReturn && o.fulfillmentMode === "seller",
      returnTrackingNumber: snap.returnTrackingNumber,
      returnCarrier: snap.returnCarrier,
      externalCreatedAt: snap.createdAt,
      externalUpdatedAt: snap.updatedAt,
    };
    if (!existing) {
      // a cancellation request is only worth a row while it waits for the seller
      if (cancellation && snap.state !== "requested") return "ignored";
      const row = await this.repo.insert(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        storeId: store.id,
        orderId,
        warehouseId: o.warehouseId,
        kind: snap.kind,
        externalReturnId: snap.externalReturnId,
        status: snap.state,
        ...fields,
        evidence: snap.evidence,
        notifyNew: announce && snap.state === "requested",
      });
      await this.repo.replaceItems(tx, ctx.tenantId, row.id, planned);
      return "created";
    }
    if (existing.externalUpdatedAt && snap.updatedAt < existing.externalUpdatedAt) return "stale";
    const next = nextStatus(existing.status, snap.state);
    const reopened = next === "requested" && FINAL_STATUSES.has(existing.status);
    const patch = {
      ...fields,
      // the photos come from `details` when the listing has none (TikTok Shop)
      ...(snap.evidence.length > 0 ? { evidence: snap.evidence } : {}),
      ...((existing.respondByAt?.getTime() ?? null) !== (snap.respondBy?.getTime() ?? null)
        ? { dueAlertedAt: null }
        : {}),
      ...(reopened
        ? {
            decision: null,
            decisionAction: null,
            decidedFor: null,
            responseStatus: null,
            response: null,
            responseError: null,
            notifyNew: announce,
          }
        : {}),
      ...(next ? { status: next } : {}),
    };
    await withStatusSource(tx, "marketplace", () => this.repo.update(tx, existing.id, patch));
    if (!existing.receivedAt) {
      const stored = await this.repo.items(tx, [existing.id]);
      if (itemsChanged(stored, planned)) await this.repo.replaceItems(tx, ctx.tenantId, existing.id, planned);
    }
    return "updated";
  }

  /**
   * Decisions of the store's changed requests, DETAILS_PER_RUN at a time. A full batch that got
   * somewhere continues in a `return.details` job, so a burst of new requests can be answered soon
   * instead of a batch per poll.
   */
  private async readDecisions(ctx: RequestContext, store: StoreRow, queueJobId?: string) {
    const now = new Date();
    const stale = await withTenantTx(this.db, ctx, (tx) =>
      this.repo.claimStaleDecisions(tx, store.id, DETAILS_PER_RUN, now, new Date(now.getTime() - DETAILS_LEASE_MS)),
    );
    if (stale.length === 0) return;
    const read = await this.readDetailsOf(ctx, store, stale, queueJobId);
    if (read > 0 && stale.length === DETAILS_PER_RUN) {
      await withTenantTx(this.db, ctx, (tx) =>
        this.outbox.enqueue(tx, ctx, returnDetailsRequested, { storeId: store.id }, store.id),
      );
    }
  }

  /** `return.details`: the next batch of decisions. */
  async continueDecisions(ctx: RequestContext, storeId: string, queueJobId?: string): Promise<void> {
    const store = await this.usable(ctx, storeId);
    if (store) await this.readDecisions(ctx, store, queueJobId);
  }

  /**
   * What the seller may decide on these requests, and their photos, read for their marketplace status.
   * A request the marketplace refuses to describe gets no decisions for that status; a temporary failure
   * leaves the rest for the next run. Returns how many requests got their decisions.
   */
  private async readDetailsOf(
    ctx: RequestContext,
    store: StoreRow,
    rows: ReturnRow[],
    queueJobId?: string,
  ): Promise<number> {
    let read = 0;
    const refs = await withTenantTx(this.db, ctx, (tx) =>
      this.orders.refsIn(
        tx,
        rows.map((r) => r.orderId),
      ),
    );
    for (const r of rows) {
      const status = r.externalStatus ?? "";
      let details: { decisions: ReturnRow["decisions"]; evidence: ReturnRow["evidence"] | null };
      try {
        details = await this.gateway.call(
          ctx,
          store.id,
          {
            kind: "returns.details",
            direction: "pull",
            request: { kind: r.kind, status },
            ...(queueJobId ? { queueJobId } : {}),
          },
          (connector, shop) =>
            connector.returns.details(shop, {
              externalReturnId: r.externalReturnId!,
              externalOrderId: refs.get(r.orderId)?.externalOrderId ?? "",
              kind: r.kind === "rto" ? "return_refund" : r.kind,
              externalStatus: status,
            }),
          (d) => ({ decisions: d.decisions.length, evidence: d.evidence?.length ?? null }),
        );
      } catch (err) {
        if (!isConnectorError(err) || err.kind !== "permanent") {
          log.warn(
            { store_id: store.id, return_id: r.id, err_code: describeSyncError(err).code },
            "return details not read",
          );
          return read;
        }
        details = { decisions: [], evidence: null };
      }
      const stored = await withTenantTx(this.db, ctx, async (tx) => {
        const current = await this.repo.get(tx, r.id, true);
        if (!current) return false;
        // the request moved on while we asked: its decisions are read again next time
        if ((current.externalStatus ?? "") !== status) {
          await this.repo.update(tx, r.id, { decisionsClaimedAt: null });
          return false;
        }
        await this.repo.update(tx, r.id, {
          decisions: details.decisions,
          decisionsFor: current.externalStatus,
          decisionsReadAt: new Date(),
          decisionsClaimedAt: null,
          ...(details.evidence && details.evidence.length > 0 ? { evidence: details.evidence } : {}),
        });
        return true;
      });
      if (stored) read++;
    }
    return read;
  }

  /**
   * Sends the seller's decision (FR-RET-02): the photos first, then the decision with an idempotency
   * key per attempt, then the request is read again. A refusal by the marketplace fails the decision with
   * its words; a temporary failure is retried, and fails it after the last attempt.
   */
  async respond(
    ctx: RequestContext,
    id: string,
    attempt: number,
    queueJobId: string | undefined,
    willRetry: boolean,
  ): Promise<"sent" | "failed" | "skipped"> {
    const loaded = await withTenantTx(this.db, ctx, async (tx) => {
      const row = await this.repo.get(tx, id);
      if (row?.responseStatus !== "pending" || row.responseAttempt !== attempt || !row.response) return null;
      const refs = await this.orders.refsIn(tx, [row.orderId]);
      return { row, externalOrderId: refs.get(row.orderId)?.externalOrderId ?? "" };
    });
    if (!loaded) return "skipped";
    const { row, externalOrderId } = loaded;
    const response = row.response!;
    const store = await this.usable(ctx, row.storeId);
    if (!store)
      return this.failResponse(ctx, id, attempt, "Toko tidak terhubung. Hubungkan ulang tokonya lalu kirim lagi.");
    const job = queueJobId ? { queueJobId } : {};
    try {
      const photos: (UploadedEvidence & { module: number | null })[] = [];
      for (const e of response.evidence) {
        const bytes = await this.files.read(ctx, e.fileId);
        const meta = row.sellerEvidence.find((f) => f.fileId === e.fileId);
        if (!bytes || !meta) {
          return this.failResponse(ctx, id, attempt, "Foto bukti sudah tidak tersedia. Unggah ulang lalu kirim lagi.");
        }
        const up = await this.gateway.call(
          ctx,
          store.id,
          { kind: "returns.evidence", direction: "push", request: { bytes: bytes.length }, ...job },
          (connector, shop) =>
            connector.returns.uploadEvidence(shop, {
              externalReturnId: row.externalReturnId!,
              kind: row.kind === "rto" ? "return_refund" : row.kind,
              bytes,
              contentType: meta.contentType,
            }),
        );
        photos.push({ ...up, module: e.module });
      }
      await this.gateway.call(
        ctx,
        store.id,
        { kind: "returns.respond", direction: "push", request: { kind: row.kind, decision: row.decision }, ...job },
        (connector, shop) =>
          connector.returns.respond(shop, {
            externalReturnId: row.externalReturnId!,
            externalOrderId,
            kind: row.kind === "rto" ? "return_refund" : row.kind,
            decision: row.decision!,
            reason: response.reason,
            comment: response.comment,
            evidence: photos,
            email: response.email ?? null,
            idempotencyKey: `${row.id}-${attempt}`,
          }),
      );
    } catch (err) {
      if (isConnectorError(err) && err.kind !== "transient") {
        return this.failResponse(ctx, id, attempt, describeSyncError(err).message);
      }
      if (willRetry) throw err;
      return this.failResponse(ctx, id, attempt, describeSyncError(err).message);
    }
    await withTenantTx(this.db, ctx, (tx) =>
      this.repo.settleResponse(tx, id, attempt, {
        responseStatus: "sent",
        response: { ...response, email: null },
        responseError: null,
      }),
    );
    log.info({ return_id: id, decision: row.decision }, "return decision sent");
    try {
      await this.refreshRequest(ctx, id, queueJobId);
    } catch (err) {
      // sent is sent: the next pull reads the request
      log.warn({ return_id: id, err_code: describeSyncError(err).code }, "return not read back yet");
    }
    return "sent";
  }

  private async failResponse(ctx: RequestContext, id: string, attempt: number, message: string): Promise<"failed"> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const row = await this.repo.get(tx, id);
      if (!row?.response) return;
      await this.repo.settleResponse(tx, id, attempt, {
        responseStatus: "failed",
        response: { ...row.response, email: null },
        responseError: message.slice(0, 1000),
      });
    });
    log.warn({ return_id: id }, "return decision failed");
    return "failed";
  }

  /**
   * An order cancelled after it shipped (FR-RET-06, FR-SHP-13): its parcel is expected back. One per
   * order; units are what each line shipped and has not come back. Orders a marketplace warehouse
   * fulfilled and lines without stock taken never come back to the seller's warehouse.
   */
  async openRto(ctx: RequestContext, orderId: string): Promise<boolean> {
    return withTenantTx(this.db, ctx, async (tx) => {
      if (await this.repo.rtoOf(tx, orderId)) return false;
      const { orders, items } = await this.orders.readIn(tx, [orderId]);
      const o = orders[0];
      if (o?.fulfillmentMode !== "seller" || o.status !== "cancelled") return false;
      const planned = rtoItems(items.map(orderLine));
      if (planned.length === 0) return false;
      const row = await this.repo.insert(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        storeId: o.storeId,
        orderId,
        warehouseId: o.warehouseId,
        kind: "rto",
        externalReturnId: null,
        status: "in_transit",
        externalStatus: o.externalStatus,
        initiator: "marketplace",
        reason: o.cancelReason,
        refundAmount: null,
        currency: o.currency,
        goodsReturn: true,
        returnTrackingNumber: o.trackingNumber,
        returnCarrier: o.shippingProvider,
        notifyNew: true,
      });
      await this.repo.replaceItems(tx, ctx.tenantId, row.id, planned);
      return true;
    });
  }
}
