import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import { DomainError } from "../../common/errors/domain-errors";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { REALTIME, type Realtime } from "../../realtime/realtime";
import type { DeviceRow } from "../identity/devices.repository";
import { DevicesService } from "../identity/devices.service";
import { WarehousesService } from "../inventory/warehouses.service";
import { printAgentNotFound, printWarehouseInvalid } from "./fulfillment.errors";
import { FulfillmentService } from "./fulfillment.service";
import type { PrintJobRow } from "./print.repository";
import { PrintService } from "./print.service";
import { printerFor } from "./scan-plan";

/**
 * Print agents of a business (FR-SHP-17, UI L42, backend doc 8.24): pairing a computer (its token is
 * shown once), its default printers for labels and A4, revoking it, and the test page. The `device` rows
 * belong to identity (DevicesService); this service owns the rules around print agents, which are about
 * printing: warehouses, the print queue, and the agent's connection.
 */
@Injectable()
export class PrintAgentsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(PrintService) private readonly print: PrintService,
    @Inject(FulfillmentService) private readonly fulfillment: FulfillmentService,
    @Inject(REALTIME) private readonly realtime: Realtime,
  ) {}

  /** Agents of the caller's warehouses and those serving every warehouse, newest first. */
  async list(ctx: RequestContext): Promise<DeviceRow[]> {
    return withTenantTx(this.db, ctx, async (tx) =>
      (await this.devices.activeIn(tx, "print_agent")).filter((d) => this.visible(ctx, d)),
    );
  }

  async get(ctx: RequestContext, id: string): Promise<DeviceRow> {
    return withTenantTx(this.db, ctx, (tx) => this.getIn(tx, ctx, id));
  }

  /** Pairs a computer: the agent and its token, which is never shown again. */
  async create(
    ctx: RequestContext,
    input: { name: string; warehouseId: string | null },
  ): Promise<{ device: DeviceRow; token: string }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      if (input.warehouseId) await this.warehouseIn(tx, ctx, input.warehouseId);
      return this.devices.createIn(tx, ctx, { kind: "print_agent", name: input.name, warehouseId: input.warehouseId });
    });
  }

  /** Name, warehouse, and the printers that take labels and A4 documents when a request names none. */
  async update(
    ctx: RequestContext,
    id: string,
    patch: {
      name?: string | undefined;
      warehouseId?: string | null | undefined;
      labelPrinter?: string | null | undefined;
      documentPrinter?: string | null | undefined;
    },
  ): Promise<DeviceRow> {
    return withTenantTx(this.db, ctx, async (tx) => {
      await this.getIn(tx, ctx, id, true);
      if (patch.warehouseId) await this.warehouseIn(tx, ctx, patch.warehouseId);
      return this.devices.updateIn(tx, id, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.warehouseId !== undefined ? { warehouseId: patch.warehouseId } : {}),
        ...(patch.labelPrinter !== undefined ? { labelPrinter: patch.labelPrinter } : {}),
        ...(patch.documentPrinter !== undefined ? { documentPrinter: patch.documentPrinter } : {}),
      });
    });
  }

  /**
   * Revokes the agent: its token stops working at once, its open jobs are cancelled, and its connection
   * is closed. The row stays for the print history.
   */
  async revoke(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      await this.getIn(tx, ctx, id, true);
      await this.devices.revokeIn(tx, id);
      await this.print.cancelForDeviceIn(tx, id);
    });
    this.realtime.disconnectDevice(id);
  }

  /** "Cetak percobaan": a test page on this agent, on the printer asked for or its label printer. */
  async testPrint(ctx: RequestContext, id: string, printer?: string | null): Promise<PrintJobRow> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const d = await this.getIn(tx, ctx, id);
      const doc = await this.fulfillment.requestDocumentIn(tx, ctx, "test_page", {
        orderIds: [],
        device: { name: d.name, printer: printerFor(printer, "label", d) },
      });
      return this.print.queueIn(tx, ctx, doc, { deviceId: d.id, printer }, "Cetak percobaan", "deviceId");
    });
  }

  private visible(ctx: RequestContext, d: DeviceRow): boolean {
    return ctx.warehouseScope === null || d.warehouseId === null || ctx.warehouseScope.has(d.warehouseId);
  }

  private async getIn(tx: Tx, ctx: RequestContext, id: string, lock = false): Promise<DeviceRow> {
    const d = await this.devices.getIn(tx, id, lock);
    if (d?.kind !== "print_agent" || d.revokedAt || !this.visible(ctx, d)) throw printAgentNotFound();
    return d;
  }

  private async warehouseIn(tx: Tx, ctx: RequestContext, id: string): Promise<void> {
    try {
      await this.warehouses.visibleOneIn(tx, ctx, id);
    } catch (err) {
      if (err instanceof DomainError && err.status === 404) throw printWarehouseInvalid();
      throw err;
    }
  }
}
