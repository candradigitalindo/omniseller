import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import type { RequestContext } from "../../common/context/request-context";
import type { ExportLookups, ExportSheet } from "../../common/export-sheet";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { AffiliateService } from "../affiliate/affiliate.service";
import { AffiliateAccountsService } from "../affiliate-accounts/accounts.service";
import { OrderRulesService } from "../automation/order-rules.service";
import { BillingService } from "../billing/billing.service";
import { BusinessProfileService } from "../business/business-profile.service";
import { CourierCalendarService } from "../campaign/courier-calendar.service";
import { ListingPriceService } from "../catalog/listing-price.service";
import { ListingsService } from "../catalog/listings.service";
import { ProductTransferService } from "../catalog/product-transfer.service";
import { StoresService } from "../channel/stores.service";
import { FilesService } from "../files/files.service";
import { FulfillmentService } from "../fulfillment/fulfillment.service";
import { HandoverService } from "../fulfillment/handover.service";
import { RolesService } from "../identity/roles.service";
import { TenantsService } from "../identity/tenants.service";
import { UsersService } from "../identity/users.service";
import { InventoryService } from "../inventory/inventory.service";
import { StockCountService } from "../inventory/stock-count.service";
import { StockTransferService } from "../inventory/stock-transfer.service";
import { WarehousesService } from "../inventory/warehouses.service";
import { ListingCopyService } from "../listing-copy/listing-copy.service";
import { NotificationInboxService } from "../notification/inbox.service";
import { OrdersService } from "../orders/orders.service";
import { ReturnsService } from "../returns/returns.service";
import { writeCsvFile } from "./csv-file";
import { ExportsRepository } from "./exports.repository";
import { exportReadme } from "./readme";
import { writeZip } from "./zip";

const log = logger.forModule("exports");

/** A ready export is kept a week: time to download it again, short for a file full of buyer data. */
export const EXPORT_TTL_DAYS = 7;

interface WrittenFile {
  name: string;
  path: string;
  rows: number;
  description: string;
}

/**
 * Renders the full data export in the worker (queue `export`, backend doc 8.18, PRD FR-MIG-09): every
 * sheet of the owning modules is written to a CSV file in a temporary directory, all of them read in
 * one snapshot transaction, then zipped with a README, stored as a private file for 7 days, and the
 * person who asked is notified. Nothing is held in memory beyond one page of rows.
 */
@Injectable()
export class ExportRenderService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ExportsRepository) private readonly repo: ExportsRepository,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(RolesService) private readonly roles: RolesService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(ProductTransferService) private readonly products: ProductTransferService,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(ListingPriceService) private readonly listingPrices: ListingPriceService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(FulfillmentService) private readonly fulfillment: FulfillmentService,
    @Inject(HandoverService) private readonly handovers: HandoverService,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
    @Inject(ListingCopyService) private readonly listingCopies: ListingCopyService,
    @Inject(ReturnsService) private readonly returns: ReturnsService,
    @Inject(StockCountService) private readonly stockCounts: StockCountService,
    @Inject(StockTransferService) private readonly stockTransfers: StockTransferService,
    @Inject(BusinessProfileService) private readonly business: BusinessProfileService,
    @Inject(CourierCalendarService) private readonly courierCalendar: CourierCalendarService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(AffiliateAccountsService) private readonly affiliateAccounts: AffiliateAccountsService,
    @Inject(AffiliateService) private readonly affiliate: AffiliateService,
    @Inject(OrderRulesService) private readonly orderRules: OrderRulesService,
  ) {}

  /** Every sheet, in ZIP order: the business's setup, the catalog, stock, then orders. */
  sheets(): ExportSheet[] {
    return [
      ...this.affiliate.exportSheets(),
      ...this.affiliateAccounts.exportSheets(),
      ...this.business.exportSheets(),
      ...this.roles.exportSheets(),
      ...this.billing.exportSheets(),
      ...this.stores.exportSheets(),
      ...this.warehouses.exportSheets(),
      ...this.courierCalendar.exportSheets(),
      ...this.products.exportSheets(),
      ...this.listings.exportSheets(),
      ...this.listingPrices.exportSheets(),
      ...this.listingCopies.exportSheets(),
      ...this.inventory.exportSheets(),
      ...this.stockCounts.exportSheets(),
      ...this.stockTransfers.exportSheets(),
      ...this.orders.exportSheets(),
      ...this.orderRules.exportSheets(),
      ...this.fulfillment.exportSheets(),
      ...this.handovers.exportSheets(),
      ...this.returns.exportSheets(),
    ];
  }

  async render(ctx: RequestContext, exportId: string): Promise<void> {
    const job = await withTenantTx(this.db, ctx, async (tx) => {
      const e = await this.repo.get(tx, exportId, true);
      // running already: the worker that had the job stopped and BullMQ handed it to this one
      if (e?.status === "queued") await this.repo.update(tx, e.id, { status: "running" });
      return e?.status === "queued" || e?.status === "running" ? e : null;
    });
    if (!job) return;

    const dir = await mkdtemp(join(tmpdir(), "omniseller-export-"));
    try {
      const profile = await this.tenants.profile(ctx);
      const at = new Date();
      const written = await this.writeSheets(ctx, dir, profile.timezone);
      const zipPath = join(dir, "ekspor.zip");
      await writeZip(zipPath, [
        {
          name: "README.txt",
          content: exportReadme({ business: profile.name, timezone: profile.timezone, at, files: written }),
        },
        ...written.map((f) => ({ name: f.name, path: f.path })),
      ]);
      const expiresAt = new Date(Date.now() + EXPORT_TTL_DAYS * 86_400_000);
      const file = await this.files.saveFile(ctx, {
        purpose: "export",
        mime: "application/zip",
        ext: "zip",
        path: zipPath,
        expiresAt,
        createdBy: job.requestedBy,
      });
      await withTenantTx(this.db, ctx, async (tx) => {
        await this.repo.update(tx, job.id, {
          status: "ready",
          fileObjectId: file.id,
          sizeBytes: file.sizeBytes,
          expiresAt,
          result: { files: written.map(({ name, rows }) => ({ name, rows })) },
          finishedAt: new Date(),
        });
        if (job.requestedBy) {
          await this.inbox.notifyIn(tx, ctx, [
            {
              userId: job.requestedBy,
              kind: "export.ready",
              severity: "info",
              title: "Ekspor data siap diunduh",
              body: `${written.length} berkas CSV dalam satu ZIP. Unduh sebelum ${EXPORT_TTL_DAYS} hari; setelah itu berkasnya dihapus.`,
              data: { exportId: job.id },
            },
          ]);
        }
      });
    } catch (err) {
      log.error({ err, export_id: job.id }, "data export failed");
      await withTenantTx(this.db, ctx, async (tx) => {
        await this.repo.update(tx, job.id, {
          status: "failed",
          error: "Ekspor gagal dibuat. Coba minta lagi.",
          finishedAt: new Date(),
        });
        if (job.requestedBy) {
          await this.inbox.notifyIn(tx, ctx, [
            {
              userId: job.requestedBy,
              kind: "export.failed",
              severity: "warning",
              title: "Ekspor data gagal",
              body: "Ekspor gagal dibuat. Coba minta lagi dari menu Ekspor Data.",
              data: { exportId: job.id },
            },
          ]);
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** All sheets in one snapshot: a repeatable-read, read-only transaction, so the files agree. */
  private async writeSheets(ctx: RequestContext, dir: string, timeZone: string): Promise<WrittenFile[]> {
    const sheets = this.sheets();
    return withTenantTx(
      this.db,
      ctx,
      async (tx) => {
        const stores = await this.stores.namesIn(tx);
        const warehouses = await this.warehouses.codesIn(tx);
        const users = await this.users.namesIn(tx);
        const lookups: ExportLookups = {
          storeName: (id) => (id ? (stores.get(id) ?? null) : null),
          warehouseCode: (id) => (id ? (warehouses.get(id) ?? null) : null),
          userName: (id) => (id ? (users.get(id) ?? null) : null),
        };
        const written: WrittenFile[] = [];
        for (const sheet of sheets) {
          const path = join(dir, sheet.file);
          const rows = await writeCsvFile(path, sheet.columns, sheet.pages(tx, lookups), { timeZone });
          written.push({ name: sheet.file, path, rows, description: sheet.description });
        }
        return written;
      },
      { snapshot: true },
    );
  }
}
