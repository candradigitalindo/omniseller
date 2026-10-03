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
 * Store notifications (PRD FR-NTF-01 "koneksi terputus"): a store that must be authorized again, and
 * one whose authorization ends soon, for the people who manage stores (`settings:store`) and see the
 * store. Nothing is sent when the store was reconnected before the job ran.
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
