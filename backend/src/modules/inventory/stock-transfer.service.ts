import { Inject, Injectable } from "@nestjs/common";
import { newId, type StockTransferStatus } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { nextDocumentNumber } from "../../common/document-number";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import { claimIdempotencyKey, requestHash } from "../../common/idempotency";
import { localDate } from "../../common/time-zone";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { TenantsService } from "../identity/tenants.service";
import { NotificationInboxService } from "../notification/inbox.service";
import {
  rowStale,
  stockOpsProblems,
  stockTransferClosed,
  stockTransferDestinationOnly,
  stockTransferNotDraft,
  stockTransferNotFound,
  stockTransferNotSent,
  stockTransferOriginOnly,
  warehouseNotFound,
} from "./inventory.errors";
import { InventoryService } from "./inventory.service";
import { StockOpsRepository, type StockTransferLineRow, type StockTransferRow } from "./stock-ops.repository";
import { receiptLines, stockTransferNumber, type TransferLineInput, transferLineProblems } from "./stock-ops-plan";
import { WarehousesService } from "./warehouses.service";

type WarehouseRef = { id: string; code: string; name: string };

export interface StockTransferView {
  transfer: StockTransferRow;
  from: WarehouseRef | null;
  to: WarehouseRef | null;
  lines: (StockTransferLineRow & { sku: string | null; productName: string | null; variantName: string | null })[];
}

const userOf = (ctx: RequestContext) => (ctx.actor.type === "user" ? ctx.actor.id : null);
const holds = (ctx: RequestContext, warehouseId: string) =>
  ctx.warehouseScope === null || ctx.warehouseScope.has(warehouseId);

/**
 * Stock transfers between warehouses (PRD FR-STK-09, backend doc 8.27). A draft lists what goes; sending
 * takes the units from the origin (`transfer_out`, only what is available there); receiving puts what
 * arrived on hand at the destination (`transfer_in`), and what did not arrive stays recorded on the line
 * as missing. A sent transfer cancelled puts its units back at the origin. A transfer is seen by users
 * holding either warehouse; the origin's side edits, sends, and cancels, the destination's receives.
 */
@Injectable()
export class StockTransferService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(StockOpsRepository) private readonly repo: StockOpsRepository,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
  ) {}

  private async getIn(tx: Tx, ctx: RequestContext, id: string, lock = false): Promise<StockTransferRow> {
    const t = await this.repo.transfer(tx, id, lock);
    if (!t || !(holds(ctx, t.fromWarehouseId) || holds(ctx, t.toWarehouseId))) throw stockTransferNotFound();
    return t;
  }

  /** A transfer the caller may change from the origin's side, locked. */
  private async originIn(tx: Tx, ctx: RequestContext, id: string): Promise<StockTransferRow> {
    const t = await this.getIn(tx, ctx, id, true);
    if (!holds(ctx, t.fromWarehouseId)) throw stockTransferOriginOnly();
    return t;
  }

  private async viewsIn(tx: Tx, rows: StockTransferRow[]): Promise<StockTransferView[]> {
    const lines = await this.repo.transferLines(
      tx,
      rows.map((r) => r.id),
    );
    const variants = await this.inventory.variantsIn(
      tx,
      lines.map((l) => l.variantId),
    );
    const names = new Map<string, WarehouseRef>();
    for (const id of new Set(rows.flatMap((r) => [r.fromWarehouseId, r.toWarehouseId]))) {
      const w = await this.warehouses.anyIn(tx, id);
      if (w) names.set(id, { id: w.id, code: w.code, name: w.name });
    }
    return rows.map((t) => ({
      transfer: t,
      from: names.get(t.fromWarehouseId) ?? null,
      to: names.get(t.toWarehouseId) ?? null,
      lines: lines
        .filter((l) => l.stockTransferId === t.id)
        .map((l) => {
          const v = variants.get(l.variantId);
          return {
            ...l,
            sku: v?.sku ?? null,
            productName: v?.productName ?? null,
            variantName: v?.variantName ?? null,
          };
        }),
    }));
  }

  private async viewIn(tx: Tx, id: string): Promise<StockTransferView> {
    const t = (await this.repo.transfer(tx, id))!;
    return (await this.viewsIn(tx, [t]))[0]!;
  }

  /** Lines checked: something to send, each variant once and known to the catalog. */
  private async checkLinesIn(tx: Tx, lines: TransferLineInput[]): Promise<void> {
    const problems = transferLineProblems(lines);
    if (problems.length > 0) throw stockOpsProblems(problems);
    const variants = await this.inventory.variantsIn(
      tx,
      lines.map((l) => l.variantId),
    );
    const unknown = lines.flatMap((l, i) =>
      variants.has(l.variantId) ? [] : [{ path: `lines.${i}.variantId`, message: "Varian produk tidak ditemukan." }],
    );
    if (unknown.length > 0) throw stockOpsProblems(unknown);
  }

  /** The destination: any active warehouse of the business other than the origin. */
  private async destinationIn(tx: Tx, fromWarehouseId: string, toWarehouseId: string): Promise<void> {
    if (toWarehouseId === fromWarehouseId) {
      throw stockOpsProblems([{ path: "toWarehouseId", message: "Gudang tujuan harus berbeda dari gudang asal." }]);
    }
    if (!(await this.warehouses.findActiveIn(tx, toWarehouseId))) throw warehouseNotFound("toWarehouseId");
  }

  /** Warehouses a transfer may go to: every active warehouse of the business, in or out of the caller's scope. */
  async destinations(ctx: RequestContext): Promise<WarehouseRef[]> {
    return withTenantTx(this.db, ctx, async (tx) =>
      (await this.warehouses.activeIn(tx)).map((w) => ({ id: w.id, code: w.code, name: w.name })),
    );
  }

  /** A draft from a warehouse the caller holds. With Idempotency-Key a repeated request returns the first. */
  async create(
    ctx: RequestContext,
    input: {
      fromWarehouseId: string;
      toWarehouseId: string;
      note?: string | null | undefined;
      lines: TransferLineInput[];
    },
    idempotencyKey?: string,
  ): Promise<{ view: StockTransferView; created: boolean }> {
    const timezone = await this.tenants.timezone(ctx);
    return withTenantTx(this.db, ctx, async (tx) => {
      const id = newId();
      if (idempotencyKey) {
        const earlier = await claimIdempotencyKey(tx, ctx, {
          scope: "stock_transfer.create",
          key: idempotencyKey,
          hash: requestHash(input),
          resourceId: id,
        });
        if (earlier) return { view: await this.viewIn(tx, earlier), created: false };
      }
      if ((await this.inventory.warehousesIn(tx, ctx, input.fromWarehouseId)).length === 0) {
        throw warehouseNotFound("fromWarehouseId");
      }
      await this.destinationIn(tx, input.fromWarehouseId, input.toWarehouseId);
      await this.checkLinesIn(tx, input.lines);
      const period = localDate(timezone, new Date()).slice(2, 7).replace("-", "");
      await this.repo.insertTransfer(tx, {
        id,
        tenantId: ctx.tenantId,
        number: stockTransferNumber(period, await nextDocumentNumber(tx, ctx.tenantId, "stock_transfer", period)),
        fromWarehouseId: input.fromWarehouseId,
        toWarehouseId: input.toWarehouseId,
        note: input.note?.trim() || null,
        createdBy: userOf(ctx),
      });
      await this.repo.replaceTransferLines(
        tx,
        ctx.tenantId,
        id,
        input.lines.map((l) => ({ id: newId(), variantId: l.variantId, qty: l.qty })),
      );
      return { view: await this.viewIn(tx, id), created: true };
    });
  }

  /**
   * Newest first; those leaving or reaching the caller's warehouses. `direction` with `warehouseId` (or
   * the caller's scope): only leaving (`out`) or only arriving (`in`).
   */
  async list(
    ctx: RequestContext,
    f: {
      status?: StockTransferStatus | undefined;
      warehouseId?: string | undefined;
      direction?: "out" | "in" | undefined;
    },
    before: string | undefined,
    limit: number,
  ): Promise<{ items: StockTransferView[]; more: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const scope = ctx.warehouseScope ? [...ctx.warehouseScope] : null;
      if (f.warehouseId && scope && !scope.includes(f.warehouseId)) return { items: [], more: false };
      const rows = await this.repo.listTransfers(tx, { ...f, warehouseIds: scope }, before, limit);
      return { items: await this.viewsIn(tx, rows.slice(0, limit)), more: rows.length > limit };
    });
  }

  async get(ctx: RequestContext, id: string): Promise<StockTransferView> {
    return withTenantTx(this.db, ctx, async (tx) => (await this.viewsIn(tx, [await this.getIn(tx, ctx, id)]))[0]!);
  }

  /** A draft changed: destination, note, or its lines (replaced as a whole). `ifMatch` is the row version seen. */
  async update(
    ctx: RequestContext,
    id: string,
    patch: {
      toWarehouseId?: string | undefined;
      note?: string | null | undefined;
      lines?: TransferLineInput[] | undefined;
    },
    ifMatch?: number,
  ): Promise<StockTransferView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const t = await this.originIn(tx, ctx, id);
      if (t.status !== "draft") throw stockTransferNotDraft();
      if (ifMatch !== undefined && ifMatch !== t.rowVersion) throw rowStale();
      if (patch.toWarehouseId !== undefined) await this.destinationIn(tx, t.fromWarehouseId, patch.toWarehouseId);
      if (patch.lines !== undefined) {
        await this.checkLinesIn(tx, patch.lines);
        await this.repo.replaceTransferLines(
          tx,
          ctx.tenantId,
          t.id,
          patch.lines.map((l) => ({ id: newId(), variantId: l.variantId, qty: l.qty })),
        );
      }
      const ok = await this.repo.updateTransfer(
        tx,
        t.id,
        {
          ...(patch.toWarehouseId !== undefined ? { toWarehouseId: patch.toWarehouseId } : {}),
          ...(patch.note !== undefined ? { note: patch.note?.trim() || null } : {}),
          // a change of lines alone still changes the transfer: its version moves
          updatedAt: new Date(),
        },
        t.rowVersion,
      );
      if (!ok) throw rowStale();
      return this.viewIn(tx, t.id);
    });
  }

  /**
   * The goods leave the origin: each line must be available there now (not reserved for orders, not
   * held back), else nothing moves and the short lines are named. The destination's users hear of it.
   */
  async send(ctx: RequestContext, id: string): Promise<StockTransferView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const t = await this.originIn(tx, ctx, id);
      if (t.status !== "draft") throw stockTransferNotDraft();
      const lines = await this.repo.transferLines(tx, [t.id]);
      if (!(await this.warehouses.findActiveIn(tx, t.toWarehouseId))) throw warehouseNotFound("toWarehouseId");
      const { short } = await this.inventory.transferMovementsIn(tx, ctx, {
        direction: "out",
        warehouseId: t.fromWarehouseId,
        lines: lines.map((l) => ({ lineId: l.id, variantId: l.variantId, qty: l.qty })),
        note: `Transfer ${t.number}`,
      });
      if (short.length > 0) {
        throw stockOpsProblems(
          short.map((s) => ({
            path: `lines.${lines.findIndex((l) => l.id === s.lineId)}.qty`,
            message: `Stok tersedia di gudang asal hanya ${Math.max(0, s.available)}.`,
          })),
        );
      }
      await this.repo.updateTransfer(tx, t.id, { status: "sent", sentAt: new Date(), sentBy: userOf(ctx) });
      const view = await this.viewIn(tx, t.id);
      const units = lines.reduce((n, l) => n + l.qty, 0);
      await this.inbox.notifyScopedIn(tx, ctx, "inventory:transfer", [{ warehouseId: t.toWarehouseId }], () => ({
        kind: "stock_transfer.sent",
        severity: "info",
        title: `Transfer ${t.number} dikirim ke ${view.to?.name ?? "gudang tujuan"}`,
        body: `${units} unit (${lines.length} SKU) dari ${view.from?.name ?? "gudang asal"}. Catat penerimaannya saat barang tiba.`,
        data: {
          stockTransferId: t.id,
          number: t.number,
          fromWarehouseId: t.fromWarehouseId,
          toWarehouseId: t.toWarehouseId,
        },
      }));
      return view;
    });
  }

  /**
   * The goods arrived: what arrived goes on hand at the destination; lines left out of `lines` arrived in
   * full. Units that did not arrive stay recorded on the line (sent minus received): they already left
   * the origin, so nothing else moves.
   */
  async receive(
    ctx: RequestContext,
    id: string,
    input: { lines?: { lineId: string; receivedQty: number }[] | undefined; note?: string | null | undefined },
  ): Promise<StockTransferView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const t = await this.getIn(tx, ctx, id, true);
      if (!holds(ctx, t.toWarehouseId)) throw stockTransferDestinationOnly();
      if (t.status !== "sent") throw stockTransferNotSent();
      const lines = await this.repo.transferLines(tx, [t.id]);
      const { problems, received } = receiptLines(lines, input.lines ?? []);
      if (problems.length > 0) throw stockOpsProblems(problems);
      await this.inventory.transferMovementsIn(tx, ctx, {
        direction: "in",
        warehouseId: t.toWarehouseId,
        lines: lines.map((l) => ({ lineId: l.id, variantId: l.variantId, qty: received.get(l.id) ?? 0 })),
        note: `Transfer ${t.number}`,
      });
      await this.repo.setReceived(tx, received);
      await this.repo.updateTransfer(tx, t.id, {
        status: "received",
        receivedAt: new Date(),
        receivedBy: userOf(ctx),
        receiptNote: input.note?.trim() || null,
      });
      return this.viewIn(tx, t.id);
    });
  }

  /** A draft is dropped; a sent transfer's units go back on hand at the origin. */
  async cancel(ctx: RequestContext, id: string): Promise<StockTransferView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const t = await this.originIn(tx, ctx, id);
      if (t.status !== "draft" && t.status !== "sent") throw stockTransferClosed();
      if (t.status === "sent") {
        const lines = await this.repo.transferLines(tx, [t.id]);
        await this.inventory.transferMovementsIn(tx, ctx, {
          direction: "in",
          warehouseId: t.fromWarehouseId,
          lines: lines.map((l) => ({ lineId: l.id, variantId: l.variantId, qty: l.qty })),
          note: `Transfer ${t.number} dibatalkan`,
        });
      }
      await this.repo.updateTransfer(tx, t.id, {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledBy: userOf(ctx),
      });
      return this.viewIn(tx, t.id);
    });
  }

  // ---- full data export (FR-MIG-09) ----

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "transfer_stok.csv",
        description: "Transfer stok antar gudang: asal, tujuan, status, siapa yang mengirim dan menerima.",
        columns: [
          "nomor",
          "gudang_asal",
          "gudang_tujuan",
          "status",
          "catatan",
          "dibuat_oleh",
          "dibuat_pada",
          "dikirim_oleh",
          "dikirim_pada",
          "diterima_oleh",
          "diterima_pada",
          "catatan_penerimaan",
          "dibatalkan_oleh",
          "dibatalkan_pada",
          "id",
        ],
        pages: (tx, l) =>
          keysetPages(
            (after) => this.repo.transfersPage(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((t) => [
                t.number,
                l.warehouseCode(t.fromWarehouseId),
                l.warehouseCode(t.toWarehouseId),
                t.status,
                t.note,
                l.userName(t.createdBy),
                t.createdAt,
                l.userName(t.sentBy),
                t.sentAt,
                l.userName(t.receivedBy),
                t.receivedAt,
                t.receiptNote,
                l.userName(t.cancelledBy),
                t.cancelledAt,
                t.id,
              ]),
          ),
      },
      {
        file: "transfer_stok_baris.csv",
        description: "Barang tiap transfer stok: jumlah dikirim dan diterima (selisihnya hilang di jalan).",
        columns: [
          "nomor_transfer",
          "sku_varian",
          "nama_produk",
          "nama_varian",
          "jumlah_dikirim",
          "jumlah_diterima",
          "id_transfer",
          "id_varian",
          "id",
        ],
        pages: (tx) =>
          keysetPages(
            (after) => this.repo.transferLinesPage(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((r) => [
                r.number,
                r.sku,
                r.productName,
                r.variantName,
                r.qty,
                r.receivedQty,
                r.stockTransferId,
                r.variantId,
                r.id,
              ]),
          ),
      },
    ];
  }
}
