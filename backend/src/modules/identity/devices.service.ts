import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { deviceContext, type RequestContext } from "../../common/context/request-context";
import { hashToken, newSecretToken } from "../../common/security/tokens";
import type { DbHandle, Tx } from "../../db/client";
import type { ReportedPrinter } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { type DeviceKind, type DeviceRow, DevicesRepository } from "./devices.repository";
import { PreTenantLookup } from "./identity.repository";

/** A device counts as connected this long after it last reported; agents report every minute. */
export const DEVICE_ONLINE_MS = 2 * 60_000;
/** `last_seen_at` is written at most this often per device. */
const SEEN_WRITE_MS = 30_000;

export interface DeviceAuth {
  tenantId: string;
  deviceId: string;
  kind: DeviceKind;
  tenantStatus: "active" | "suspended" | "closing" | "closed";
}

export const isOnline = (d: { lastSeenAt: Date | null }, now = Date.now()): boolean =>
  !!d.lastSeenAt && now - d.lastSeenAt.getTime() < DEVICE_ONLINE_MS;

/**
 * Devices of a business (backend doc 8.24): print agents now, the warehouse app later. A device signs in
 * with a 256-bit token shown once at pairing; only its hash is stored. A revoked device stays as a row
 * (its print jobs keep their history) and its token stops working at once. Callers that manage print
 * agents (FulfillmentModule's PrintAgentsService) own the rules around them.
 */
@Injectable()
export class DevicesService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(DevicesRepository) private readonly repo: DevicesRepository,
    @Inject(PreTenantLookup) private readonly lookup: PreTenantLookup,
  ) {}

  async createIn(
    tx: Tx,
    ctx: RequestContext,
    input: { kind: DeviceKind; name: string; warehouseId: string | null },
  ): Promise<{ device: DeviceRow; token: string }> {
    const token = newSecretToken();
    const device = await this.repo.insert(tx, {
      id: newId(),
      tenantId: ctx.tenantId,
      kind: input.kind,
      name: input.name,
      tokenHash: hashToken(token),
      warehouseId: input.warehouseId,
    });
    return { device, token };
  }

  /** Device names by id, revoked ones included, in the caller's transaction (the audit log). */
  async namesIn(tx: Tx): Promise<Map<string, string>> {
    return new Map((await this.repo.names(tx)).map((d) => [d.id, d.name]));
  }

  getIn(tx: Tx, id: string, lock = false): Promise<DeviceRow | undefined> {
    return this.repo.get(tx, id, lock);
  }

  /** Devices of this kind that are not revoked, newest first. */
  activeIn(tx: Tx, kind: DeviceKind): Promise<DeviceRow[]> {
    return this.repo.active(tx, kind);
  }

  updateIn(
    tx: Tx,
    id: string,
    patch: Partial<Pick<DeviceRow, "name" | "warehouseId" | "labelPrinter" | "documentPrinter">>,
  ): Promise<DeviceRow> {
    return this.repo.update(tx, id, patch);
  }

  revokeIn(tx: Tx, id: string): Promise<DeviceRow> {
    return this.repo.update(tx, id, { revokedAt: new Date() });
  }

  /** What the agent reports about itself (`PUT /v1/agent/status`): its version and printers. */
  reportIn(tx: Tx, id: string, report: { appVersion: string; printers: ReportedPrinter[] }): Promise<DeviceRow> {
    return this.repo.update(tx, id, {
      appVersion: report.appVersion,
      printers: report.printers,
      lastSeenAt: new Date(),
    });
  }

  /**
   * The device behind a token (REST and WebSocket alike): unknown and revoked tokens give null. Notes
   * that the device was seen, at most every 30 seconds.
   */
  async authenticate(token: string): Promise<DeviceAuth | null> {
    const row = await this.lookup.device(hashToken(token));
    if (!row || row.revoked_at) return null;
    if (!row.last_seen_at || Date.now() - row.last_seen_at.getTime() >= SEEN_WRITE_MS) {
      await withTenantTx(this.db, deviceContext(row.tenant_id, row.device_id), (tx) =>
        this.repo.update(tx, row.device_id, { lastSeenAt: new Date() }),
      );
    }
    return { tenantId: row.tenant_id, deviceId: row.device_id, kind: row.kind, tenantStatus: row.tenant_status };
  }
}
