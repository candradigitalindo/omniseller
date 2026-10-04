import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { StoresService } from "../channel/stores.service";
import { NotificationInboxService } from "../notification/inbox.service";
import { DUE_ALERT_MS } from "./return-plan";
import { ReturnsRepository } from "./returns.repository";
import { awaitsSeller } from "./returns.service";

/** Requests taken per scan; the rest waits for the next one. */
const BATCH = 200;

const KIND_LABEL: Record<string, string> = {
  return_refund: "retur dan refund",
  refund_only: "refund",
  replacement: "penggantian barang",
  exchange: "penukaran",
  cancellation: "pembatalan",
};

/**
 * Return notifications (PRD FR-NTF-01, FR-RET-07): new requests that wait for the seller go to the
 * people who answer them (`return:respond`), returning parcels to those who receive goods
 * (`return:receive`), each about the stores and warehouses in their scope; and requests whose deadline
 * is within 12 hours, once per deadline. Stores in read-only mode are answered in the old application
 * and are left out.
 */
@Injectable()
export class ReturnAlertsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ReturnsRepository) private readonly repo: ReturnsRepository,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
  ) {}

  async notifyNew(ctx: RequestContext): Promise<{ requests: number; notified: number }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const pending = await this.repo.pendingNotices(tx, BATCH);
      if (pending.length === 0) return { requests: 0, notified: 0 };
      await this.repo.clearNotices(
        tx,
        pending.map((r) => r.id),
      );
      const targets = await this.stores.stockTargetsIn(tx, [...new Set(pending.map((r) => r.storeId))]);
      const live = pending.filter((r) => targets.get(r.storeId)?.store.syncMode === "live");
      const asks = live
        .filter((r) => r.kind !== "rto" && r.status === "requested")
        .map((r) => ({ r, storeId: r.storeId, warehouseId: r.warehouseId }));
      const parcels = live
        .filter((r) => r.kind === "rto")
        .map((r) => ({ r, storeId: r.storeId, warehouseId: r.warehouseId }));
      let notified = await this.inbox.notifyScopedIn(tx, ctx, "return:respond", asks, (theirs) => {
        const cancels = theirs.filter((t) => t.r.kind === "cancellation").length;
        const returns = theirs.length - cancels;
        const parts = [returns ? `${returns} retur` : null, cancels ? `${cancels} pembatalan` : null].filter(Boolean);
        return {
          kind: "return.new",
          severity: "info",
          title: `${parts.join(" dan ")} menunggu keputusan`,
          body: theirs
            .slice(0, 5)
            .map((t) => `${targets.get(t.storeId)?.store.name ?? "Toko"}: ${KIND_LABEL[t.r.kind] ?? t.r.kind}`)
            .join(", "),
          data: { count: theirs.length, returnIds: theirs.slice(0, 50).map((t) => t.r.id) },
        };
      });
      notified += await this.inbox.notifyScopedIn(tx, ctx, "return:receive", parcels, (theirs) => ({
        kind: "return.parcel_back",
        severity: "info",
        title: `${theirs.length} paket akan kembali ke gudang`,
        body: "Pesanan dibatalkan setelah dikirim. Catat kondisi barangnya saat paket tiba.",
        data: { count: theirs.length, returnIds: theirs.slice(0, 50).map((t) => t.r.id) },
      }));
      return { requests: pending.length, notified };
    });
  }

  /** FR-RET-07: requests the marketplace decides by itself within 12 hours, once per deadline. */
  async alertDue(ctx: RequestContext, now = new Date()): Promise<{ requests: number; notified: number }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const due = await this.repo.dueUnalerted(tx, new Date(now.getTime() + DUE_ALERT_MS), BATCH);
      if (due.length === 0) return { requests: 0, notified: 0 };
      await this.repo.markDueAlerted(
        tx,
        due.map((r) => r.id),
        now,
      );
      const targets = await this.stores.stockTargetsIn(tx, [...new Set(due.map((r) => r.storeId))]);
      const waiting = due
        .filter((r) => awaitsSeller(r) && r.respondByAt! > now && targets.get(r.storeId)?.store.syncMode === "live")
        .map((r) => ({ r, storeId: r.storeId, warehouseId: r.warehouseId }));
      const notified = await this.inbox.notifyScopedIn(tx, ctx, "return:respond", waiting, (theirs) => {
        const first = theirs.reduce((a, b) => (a.r.respondByAt! <= b.r.respondByAt! ? a : b));
        const hours = Math.max(1, Math.round((first.r.respondByAt!.getTime() - now.getTime()) / 3600_000));
        return {
          kind: "return.due_soon",
          severity: "warning",
          title: `${theirs.length} pengajuan harus ditanggapi`,
          body: `Tenggat terdekat sekitar ${hours} jam lagi. Tanpa tanggapan, marketplace memutuskan sendiri.`,
          data: { count: theirs.length, returnIds: theirs.slice(0, 50).map((t) => t.r.id) },
        };
      });
      return { requests: due.length, notified };
    });
  }
}
