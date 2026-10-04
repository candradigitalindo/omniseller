import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { NotificationInboxService } from "../notification/inbox.service";
import { ChannelRepository } from "./channel.repository";
import { channelDisplayName, statusMessage } from "./stores.service";

const date = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/**
 * Store notifications (PRD FR-NTF-01 "koneksi terputus", FR-WHS-10): a store that must be authorized
 * again, one whose authorization ends soon, and marketplace warehouses that appeared or disappeared, for
 * the people who manage stores (`settings:store`) and see the store. Nothing is sent when the store was
 * reconnected (or the warehouses mapped) before the job ran.
 */
@Injectable()
export class ChannelAlertsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ChannelRepository) private readonly repo: ChannelRepository,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
  ) {}

  async reauthRequired(ctx: RequestContext, storeId: string, reason: string): Promise<number> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const store = await this.repo.getStore(tx, storeId);
      if (store?.status !== "reauth_required") return 0;
      return this.inbox.notifyScopedIn(tx, ctx, "settings:store", [{ storeId }], () => ({
        kind: "store.reauth_required",
        severity: "critical",
        title: `${store.name} perlu dihubungkan ulang`,
        body: `${statusMessage(reason) ?? "Izin toko di marketplace berakhir."} Pesanan dan stok ${channelDisplayName(store.channel)} toko ini tidak tersinkron sampai toko dihubungkan lagi.`,
        data: { storeId, reason, channel: store.channel },
      }));
    });
  }

  /**
   * FR-WHS-10: the marketplace lists warehouses the store did not have, or no longer lists some. Sent when
   * an active seller warehouse is left unmapped (stock sync of the store stops, its orders become
   * problems) or one disappeared; new warehouses that were mapped automatically need nothing.
   */
  async warehousesChanged(ctx: RequestContext, storeId: string, added: number, removed: number): Promise<number> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const store = await this.repo.getStore(tx, storeId);
      if (!store || store.status === "disconnected") return 0;
      const unmapped = (await this.repo.channelWarehouses(tx, storeId)).filter(
        (w) => w.active && w.kind === "seller" && w.mappingStatus === "unmapped",
      );
      if (unmapped.length === 0 && removed === 0) return 0;
      const what = [
        added > 0 ? `${added} gudang baru` : null,
        removed > 0 ? `${removed} gudang tidak lagi tercantum` : null,
      ]
        .filter(Boolean)
        .join(" dan ");
      const names = unmapped.map((w) => w.name);
      const todo =
        unmapped.length > 0
          ? `Petakan ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` dan ${names.length - 3} lainnya` : ""} ke gudang OmniSeller. Sinkron stok toko ini berhenti dan pesanan dari gudang itu masuk daftar bermasalah sampai semuanya dipetakan.`
          : "Stok tidak lagi dikirim ke gudang yang hilang.";
      return this.inbox.notifyScopedIn(tx, ctx, "settings:store", [{ storeId }], () => ({
        kind: "store.warehouses_changed",
        severity: unmapped.length > 0 ? "warning" : "info",
        title:
          unmapped.length > 0
            ? `Gudang ${store.name} perlu dipetakan`
            : `Gudang ${channelDisplayName(store.channel)} ${store.name} berubah`,
        body: `${channelDisplayName(store.channel)} ${store.name}: ${what}. ${todo}`,
        data: { storeId, added, removed, unmapped: unmapped.length, channel: store.channel },
      }));
    });
  }

  async authorizationExpiring(ctx: RequestContext, storeId: string, expiresAt: string | null): Promise<number> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const store = await this.repo.getStore(tx, storeId);
      if (store?.status !== "token_expiring") return 0;
      const when = expiresAt ? ` pada ${date.format(new Date(expiresAt))}` : " dalam beberapa hari";
      return this.inbox.notifyScopedIn(tx, ctx, "settings:store", [{ storeId }], () => ({
        kind: "store.authorization_expiring",
        severity: "warning",
        title: `Izin ${store.name} segera berakhir`,
        body: `Izin OmniSeller di ${channelDisplayName(store.channel)} berakhir${when}. Hubungkan ulang toko sebelum itu agar pesanan dan stok tetap tersinkron.`,
        data: { storeId, expiresAt, channel: store.channel },
      }));
    });
  }
}
