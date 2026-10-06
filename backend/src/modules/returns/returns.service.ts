import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import { ValidationError } from "../../common/errors/domain-errors";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import type { DbHandle, Tx } from "../../db/client";
import type { SellerEvidenceFile } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { storeNotActive } from "../channel/channel.errors";
import { StoresService } from "../channel/stores.service";
import { FilesService } from "../files/files.service";
import { InventoryService } from "../inventory/inventory.service";
import { OrderIntakeService } from "../orders/order-intake.service";
import { OrdersService } from "../orders/orders.service";
import {
  DUE_ALERT_MS,
  FINAL_STATUSES,
  MAX_SELLER_EVIDENCE,
  type ReceiptLine,
  receiptProblems,
  responseProblems,
} from "./return-plan";
import {
  returnAlreadyReceived,
  returnDecisionsStale,
  returnEvidenceInvalid,
  returnEvidenceLimit,
  returnIsRto,
  returnNoGoods,
  returnNotFound,
  returnNothingToDecide,
  returnProblems,
  returnResponsePending,
  returnStoreReadOnly,
  returnWarehouseNotFound,
  returnWarehouseRequired,
} from "./returns.errors";
import { returnRefreshRequested, returnRespondRequested } from "./returns.events";
import { type ReturnItemRow, type ReturnListFilter, type ReturnRow, ReturnsRepository } from "./returns.repository";

const USABLE = new Set(["active", "token_expiring"]);
/** Evidence photos are kept while a dispute may still need them. */
const EVIDENCE_DAYS = 180;
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

export interface ReturnView {
  request: ReturnRow;
  store: { id: string; name: string; channel: string } | null;
  externalOrderId: string | null;
  items: ReturnItemRow[];
  /** The decisions offered now: null while they are read again for a new marketplace status. */
  decisions: ReturnRow["decisions"];
  awaitingDecision: boolean;
}

/** JPEG or PNG, told by the first bytes; anything else is refused. */
function photoType(bytes: Uint8Array): { mime: string; ext: string } | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) return { mime: "image/png", ext: "png" };
  return null;
}

/**
 * The seller waits on this request now: an open marketplace request asking for a decision (or with a
 * deadline running), not answered for its current marketplace status, and no answer on its way.
 */
export function awaitsSeller(r: ReturnRow): boolean {
  if (r.kind === "rto" || FINAL_STATUSES.has(r.status) || r.responseStatus === "pending") return false;
  if (r.status !== "requested" && !r.respondByAt) return false;
  return r.decidedFor !== r.externalStatus || r.responseStatus === "failed";
}

/**
 * Buyers' return, refund, and cancellation requests and returning parcels (PRD FR-RET-01..07, backend doc
 * 8.26), for the returns screen (L09) and the warehouse: lists and counters, the seller's decision (sent
 * by the worker), the photos it needs, and the receipt of returned goods into stock or quarantine.
 */
@Injectable()
export class ReturnsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ReturnsRepository) private readonly repo: ReturnsRepository,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(OrderIntakeService) private readonly intake: OrderIntakeService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  private visible(ctx: RequestContext, r: Pick<ReturnRow, "storeId" | "warehouseId">): boolean {
    return (
      this.stores.inScope(ctx, r.storeId) &&
      (ctx.warehouseScope === null || (r.warehouseId !== null && ctx.warehouseScope.has(r.warehouseId)))
    );
  }

  private async load(tx: Tx, ctx: RequestContext, id: string, forUpdate = false): Promise<ReturnRow> {
    const r = await this.repo.get(tx, id, forUpdate);
    if (!r || !this.visible(ctx, r)) throw returnNotFound();
    return r;
  }

  private async scopeIn(tx: Tx, ctx: RequestContext) {
    return {
      storeScope: ctx.storeScope ? [...ctx.storeScope] : null,
      warehouseScope: ctx.warehouseScope ? [...ctx.warehouseScope] : null,
      hiddenStoreIds: [...(await this.stores.disconnectedIdsIn(tx))],
    };
  }

  private async views(tx: Tx, ctx: RequestContext, rows: ReturnRow[]): Promise<ReturnView[]> {
    const items = await this.repo.items(
      tx,
      rows.map((r) => r.id),
    );
    const refs = await this.orders.refsIn(
      tx,
      rows.map((r) => r.orderId),
    );
    const stores = new Map((await this.stores.listIn(tx, ctx)).map((s) => [s.id, s]));
    return rows.map((r) => {
      const store = stores.get(r.storeId);
      return {
        request: r,
        store: store ? { id: store.id, name: store.name, channel: store.channel } : null,
        externalOrderId: refs.get(r.orderId)?.externalOrderId ?? null,
        items: items.filter((i) => i.returnRequestId === r.id),
        decisions: r.decisionsFor === r.externalStatus ? r.decisions : null,
        awaitingDecision: awaitsSeller(r),
      };
    });
  }

  async list(
    ctx: RequestContext,
    filter: Omit<ReturnListFilter, "storeScope" | "warehouseScope" | "hiddenStoreIds">,
    before: string | undefined,
    limit: number,
  ): Promise<{ items: ReturnView[]; more: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const rows = await this.repo.list(tx, { ...filter, ...(await this.scopeIn(tx, ctx)) }, before, limit);
      return { items: await this.views(tx, ctx, rows.slice(0, limit)), more: rows.length > limit };
    });
  }

  /** Counters of the returns screen: decisions waiting, deadlines within 12 hours, parcels to receive. */
  async summary(ctx: RequestContext, filter: { storeId?: string | undefined; warehouseId?: string | undefined }) {
    return withTenantTx(this.db, ctx, async (tx) =>
      this.repo.summary(tx, { ...filter, ...(await this.scopeIn(tx, ctx)) }, new Date(Date.now() + DUE_ALERT_MS)),
    );
  }

  async get(ctx: RequestContext, id: string): Promise<ReturnView> {
    return withTenantTx(this.db, ctx, async (tx) => (await this.views(tx, ctx, [await this.load(tx, ctx, id)]))[0]!);
  }

  /**
   * The request of each return line, by line id, with its order number, for the requests in the caller's
   * scope (stock card, 8.13).
   */
  async requestsOfItemsIn(
    tx: Tx,
    ctx: RequestContext,
    itemIds: string[],
  ): Promise<Map<string, { id: string; externalOrderId: string | null }>> {
    const rows = (await this.repo.itemRequests(tx, [...new Set(itemIds)])).filter((r) => this.visible(ctx, r));
    const refs = await this.orders.refsIn(
      tx,
      rows.map((r) => r.orderId),
    );
    return new Map(
      rows.map((r) => [r.itemId, { id: r.id, externalOrderId: refs.get(r.orderId)?.externalOrderId ?? null }]),
    );
  }

  /** Reads the request again from the marketplace (worker), with what the seller may decide. */
  async requestRefresh(ctx: RequestContext, id: string): Promise<{ requested: true }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const r = await this.load(tx, ctx, id);
      if (r.kind === "rto") throw returnIsRto();
      await this.outbox.enqueue(tx, ctx, returnRefreshRequested, { returnRequestId: id }, id);
      return { requested: true as const };
    });
  }

  /**
   * A photo for a rejection (FR-RET-02), kept privately for 180 days; the decision names the photos it
   * sends. Uploaded before its row is written: no transaction stays open across the upload.
   */
  async addEvidence(ctx: RequestContext, id: string, content: string): Promise<SellerEvidenceFile> {
    const bytes = new Uint8Array(Buffer.from(content, "base64"));
    const type = bytes.length > 0 && bytes.length <= MAX_EVIDENCE_BYTES ? photoType(bytes) : null;
    if (!type) throw returnEvidenceInvalid();
    await withTenantTx(this.db, ctx, async (tx) => {
      const r = await this.load(tx, ctx, id);
      if (r.kind === "rto") throw returnIsRto();
      if (r.sellerEvidence.length >= MAX_SELLER_EVIDENCE) throw returnEvidenceLimit(MAX_SELLER_EVIDENCE);
    });
    const actor = ctx.actor.type === "user" ? ctx.actor.id : null;
    const file = await this.files.save(ctx, {
      purpose: "evidence",
      bytes,
      mime: type.mime,
      ext: type.ext,
      expiresAt: new Date(Date.now() + EVIDENCE_DAYS * 86_400_000),
      createdBy: actor,
    });
    const entry: SellerEvidenceFile = {
      fileId: file.id,
      contentType: type.mime,
      size: bytes.length,
      uploadedAt: new Date().toISOString(),
      uploadedBy: actor,
    };
    return withTenantTx(this.db, ctx, async (tx) => {
      const r = await this.load(tx, ctx, id, true);
      if (r.sellerEvidence.length >= MAX_SELLER_EVIDENCE) throw returnEvidenceLimit(MAX_SELLER_EVIDENCE);
      await this.repo.update(tx, id, { sellerEvidence: [...r.sellerEvidence, entry] });
      return entry;
    });
  }

  /**
   * The seller's decision (FR-RET-02), checked against what the marketplace offers now; the worker sends
   * it (`return.respond`) and reads the request again. Refused for stores in read-only mode, where the
   * old application answers, and while an earlier decision is still on its way.
   */
  async respond(
    ctx: RequestContext,
    id: string,
    action: "accept" | "reject",
    input: {
      decision?: string | undefined;
      reason?: string | undefined;
      comment?: string | undefined;
      evidence?: { fileId: string; module?: number | undefined }[] | undefined;
      email?: string | undefined;
    },
  ): Promise<ReturnView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const r = await this.load(tx, ctx, id, true);
      if (r.kind === "rto") throw returnIsRto();
      const store = await this.stores.rowIn(tx, r.storeId);
      if (!store || !USABLE.has(store.status)) throw storeNotActive();
      if (store.syncMode === "read_only") throw returnStoreReadOnly();
      if (r.responseStatus === "pending") throw returnResponsePending();
      if (!r.decisions || r.decisionsFor !== r.externalStatus) throw returnDecisionsStale();
      if (r.decisions.length === 0) throw returnNothingToDecide();
      const options = r.decisions.filter((d) => d.action === action);
      const code = input.decision ?? (options.length === 1 ? options[0]!.code : undefined);
      if (!code) {
        throw new ValidationError([
          {
            path: "decision",
            message: options.length
              ? `Pilih keputusan: ${options.map((o) => o.code).join(", ")}.`
              : action === "accept"
                ? "Pengajuan ini tidak bisa disetujui sekarang."
                : "Pengajuan ini tidak bisa ditolak sekarang.",
          },
        ]);
      }
      const evidence = (action === "reject" ? (input.evidence ?? []) : []).map((e) => ({
        fileId: e.fileId,
        module: e.module ?? null,
      }));
      const response = {
        decision: code,
        reason: action === "reject" ? (input.reason ?? null) : null,
        comment: action === "reject" ? input.comment?.trim() || null : null,
        evidence,
        email: action === "reject" ? (input.email ?? null) : null,
      };
      const problems = responseProblems(options, response, new Set(r.sellerEvidence.map((e) => e.fileId)));
      if (problems.length > 0) throw returnProblems(problems);
      const option = options.find((o) => o.code === code)!;
      const attempt = r.responseAttempt + 1;
      await this.repo.update(tx, id, {
        decision: code,
        decisionAction: option.action,
        decidedFor: r.externalStatus,
        responseStatus: "pending",
        response: {
          label: option.label,
          reason: response.reason,
          reasonLabel: option.reasons.find((x) => x.code === response.reason)?.label ?? null,
          comment: response.comment,
          evidence,
          email: option.needsEmail ? response.email : null,
        },
        responseAttempt: attempt,
        responseError: null,
        decidedAt: new Date(),
        decidedBy: ctx.actor.type === "user" ? ctx.actor.id : null,
      });
      await this.outbox.enqueue(tx, ctx, returnRespondRequested, { returnRequestId: id, attempt }, id);
      return (await this.views(tx, ctx, [(await this.repo.get(tx, id))!]))[0]!;
    });
  }

  /**
   * Returned goods received (FR-RET-03, 06): per item, units back in sellable stock, into quarantine
   * (damaged), and not received; into the chosen warehouse (the order's by default). Stock moves through
   * InventoryService (sellable units reach the marketplaces), the order counts its returned units, and a
   * returning parcel (rto) is closed. Once per request.
   */
  async receive(
    ctx: RequestContext,
    id: string,
    input: { warehouseId?: string | undefined; note?: string | undefined; items: ReceiptLine[] },
  ): Promise<ReturnView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const r = await this.load(tx, ctx, id, true);
      if (!r.goodsReturn) throw returnNoGoods();
      if (r.receivedAt) throw returnAlreadyReceived();
      // the order before stock rows, as the order's own changes lock them
      await this.orders.lockIn(tx, [r.orderId]);
      const items = await this.repo.items(tx, [id]);
      const { items: lines } = await this.orders.readIn(tx, [r.orderId]);
      const lineOf = new Map(lines.map((l) => [l.id, l]));
      const receiptItems = items.map((i) => ({
        id: i.id,
        qty: i.qty,
        orderItemId: i.orderItemId,
        variantId: i.orderItemId ? (lineOf.get(i.orderItemId)?.variantId ?? null) : null,
      }));
      const problems = receiptProblems(receiptItems, input.items);
      if (problems.length > 0) throw returnProblems(problems);
      const warehouseId = input.warehouseId ?? r.warehouseId;
      if (!warehouseId) throw returnWarehouseRequired();
      if ((await this.inventory.warehousesIn(tx, ctx, warehouseId)).length === 0) throw returnWarehouseNotFound();

      const refs = await this.orders.refsIn(tx, [r.orderId]);
      const note = input.note?.trim() || null;
      const ref = refs.get(r.orderId)?.externalOrderId ?? r.orderId;
      await this.inventory.returnMovementsIn(
        tx,
        ctx,
        input.items.flatMap((l) => {
          const item = receiptItems.find((x) => x.id === l.returnItemId)!;
          return item.variantId
            ? [
                {
                  returnItemId: item.id,
                  variantId: item.variantId,
                  warehouseId,
                  sellable: l.sellable,
                  damaged: l.damaged,
                },
              ]
            : [];
        }),
        `${r.kind === "rto" ? "Paket kembali" : "Retur"} pesanan ${ref}`,
      );
      const now = new Date();
      for (const l of input.items) {
        await this.repo.updateItem(tx, l.returnItemId, {
          sellableQty: l.sellable,
          damagedQty: l.damaged,
          missingQty: l.missing,
          receivedAt: now,
        });
      }
      const actorId = ctx.actor.type === "user" ? ctx.actor.id : null;
      await this.repo.update(tx, id, {
        receivedAt: now,
        receivedBy: actorId,
        receivedWarehouseId: warehouseId,
        receiptNote: note,
        // a returning parcel is done once it is back
        ...(r.kind === "rto" && !FINAL_STATUSES.has(r.status) ? { status: "closed" as const } : {}),
      });
      const sum = (k: "sellable" | "damaged" | "missing") => input.items.reduce((n, l) => n + l[k], 0);
      await this.intake.returnReceivedIn(
        tx,
        ctx,
        r.orderId,
        input.items.flatMap((l) => {
          const item = receiptItems.find((x) => x.id === l.returnItemId)!;
          return item.orderItemId ? [{ orderItemId: item.orderItemId, qty: l.sellable + l.damaged }] : [];
        }),
        { type: "user", id: actorId },
        {
          returnRequestId: id,
          kind: r.kind,
          sellable: sum("sellable"),
          damaged: sum("damaged"),
          missing: sum("missing"),
        },
      );
      return (await this.views(tx, ctx, [(await this.repo.get(tx, id))!]))[0]!;
    });
  }

  // ---- other modules ----

  /** FR-INT-07, in the caller's transaction: a batch of a disconnected store's requests; 0 when none is left. */
  deleteStoreReturnsIn(tx: Tx, storeId: string, limit: number): Promise<number> {
    return this.repo.deleteStoreRequests(tx, storeId, limit);
  }

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "retur.csv",
        description:
          "Pengajuan retur, refund, dan pembatalan dari pembeli, serta paket kembali (RTO), dengan keputusan dan penerimaannya.",
        columns: [
          "toko",
          "id_pesanan",
          "jenis",
          "id_marketplace",
          "status",
          "status_marketplace",
          "kode_alasan",
          "alasan",
          "nilai_refund",
          "tenggat_respons",
          "keputusan",
          "status_tanggapan",
          "diputuskan_oleh",
          "diputuskan_pada",
          "gudang_penerima",
          "diterima_oleh",
          "diterima_pada",
          "catatan_penerimaan",
          "dibuat_pada",
          "id",
        ],
        pages: (tx, l) =>
          keysetPages(
            (after) => this.repo.page(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((r) => [
                l.storeName(r.storeId),
                r.orderId,
                r.kind,
                r.externalReturnId,
                r.status,
                r.externalStatus,
                r.reasonCode,
                r.reason,
                r.refundAmount,
                r.respondByAt,
                r.decision,
                r.responseStatus,
                l.userName(r.decidedBy),
                r.decidedAt,
                l.warehouseCode(r.receivedWarehouseId),
                l.userName(r.receivedBy),
                r.receivedAt,
                r.receiptNote,
                r.createdAt,
                r.id,
              ]),
          ),
      },
      {
        file: "retur_barang.csv",
        description: "Barang tiap pengajuan retur dan jumlah yang diterima layak jual, rusak, atau tidak diterima.",
        columns: [
          "id_retur",
          "id_baris_pesanan",
          "sku",
          "nama",
          "jumlah",
          "nilai_refund",
          "layak_jual",
          "rusak",
          "tidak_diterima",
          "diterima_pada",
          "id",
        ],
        pages: (tx) =>
          keysetPages(
            (after) => this.repo.itemsPage(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((i) => [
                i.returnRequestId,
                i.orderItemId,
                i.sku,
                i.title,
                i.qty,
                i.refundAmount,
                i.sellableQty,
                i.damagedQty,
                i.missingQty,
                i.receivedAt,
                i.id,
              ]),
          ),
      },
    ];
  }
}
