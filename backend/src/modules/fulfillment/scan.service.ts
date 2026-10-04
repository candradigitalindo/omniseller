import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { isManualChannel } from "../channel/stores.service";
import type { OrderRow } from "../orders/orders.repository";
import { OrdersService } from "../orders/orders.service";
import { scanAmbiguous, scanNotFound, scanRefused } from "./fulfillment.errors";
import { FulfillmentRepository } from "./fulfillment.repository";
import { FulfillmentService } from "./fulfillment.service";
import type { PrintJobRow } from "./print.repository";
import { PrintService, type PrintTarget } from "./print.service";
import { labelRefusal } from "./scan-plan";
import type { Refusal } from "./shipping-plan";

/** Label options of a scan: thermal by default, like the packing station prints. */
export interface ScanLabelOptions {
  format: "thermal" | "a4";
  template: "standard" | "custom";
  packingList: boolean;
}

export interface LabelPrint {
  documentId: string;
  printJob: PrintJobRow;
}

/**
 * Scanning at the warehouse (backend doc 8.24): the order behind a scanned order number or tracking
 * number, whether its label can be printed, and "scan untuk cetak" (FR-SHP-17), which renders the label
 * and sends it to a print agent with no print dialog.
 */
@Injectable()
export class ScanService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(FulfillmentRepository) private readonly repo: FulfillmentRepository,
    @Inject(FulfillmentService) private readonly fulfillment: FulfillmentService,
    @Inject(PrintService) private readonly print: PrintService,
  ) {}

  /**
   * The one order in the caller's scope whose marketplace number, tracking number, or package tracking
   * number is this code; 404 when none, 409 when several (the caller should scan the parcel's number).
   */
  async orderIn(tx: Tx, ctx: RequestContext, code: string): Promise<OrderRow> {
    const viaPackages = await this.repo.orderIdsByTracking(tx, [...new Set([code, code.toUpperCase()])]);
    const found = await this.orders.byCodeIn(tx, ctx, code, viaPackages);
    if (found.length === 0) throw scanNotFound();
    if (found.length > 1) throw scanAmbiguous(found.length);
    return found[0]!;
  }

  /** Why this order's label cannot be printed now; null when it can. */
  async labelRefusalIn(tx: Tx, o: OrderRow): Promise<Refusal | null> {
    const [s] = await this.repo.liveFor(tx, [o.id]);
    const packages = s ? await this.repo.packages(tx, [s.id]) : [];
    return labelRefusal(
      { manual: isManualChannel(o.channel), status: o.status, hasAddress: !!o.shippingAddress?.line1 },
      s,
      packages,
    );
  }

  /** The order's label as a document printed on the agent, in the caller's transaction. */
  async printLabelIn(
    tx: Tx,
    ctx: RequestContext,
    o: OrderRow,
    target: PrintTarget,
    opts: ScanLabelOptions,
    path = "print.deviceId",
  ): Promise<LabelPrint> {
    const doc = await this.fulfillment.requestDocumentIn(tx, ctx, "labels", {
      orderIds: [o.id],
      format: opts.format,
      template: opts.template,
      packingList: opts.packingList,
    });
    const printJob = await this.print.queueIn(tx, ctx, doc, target, `Label ${o.externalOrderId}`, path);
    return { documentId: doc.id, printJob };
  }

  /**
   * FR-SHP-17: scan an order number or tracking number, and its label prints on the agent. Refused with
   * the reason when the label cannot be printed (not arranged, not fetched yet, cancelled).
   */
  async scanToPrint(
    ctx: RequestContext,
    code: string,
    target: PrintTarget,
    opts: ScanLabelOptions,
  ): Promise<{ order: OrderRow } & LabelPrint> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const order = await this.orderIn(tx, ctx, code);
      const why = await this.labelRefusalIn(tx, order);
      if (why) throw scanRefused(why);
      return { order, ...(await this.printLabelIn(tx, ctx, order, target, opts, "deviceId")) };
    });
  }
}
