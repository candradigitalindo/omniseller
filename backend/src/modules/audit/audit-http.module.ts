import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { OrdersModule } from "../orders/orders.module";
import { AuditController } from "./audit.controller";
import { AuditModule } from "./audit.module";
import { AuditLogService } from "./audit-log.service";

/**
 * The readable audit log (api, backend doc 8.28). A file of its own: catalog imports audit.module.ts for
 * product history, so the modules that name records here cannot be imported from that file.
 */
@Module({
  imports: [AuditModule, IdentityModule, ChannelModule, InventoryModule, CatalogModule, OrdersModule],
  providers: [AuditLogService],
  controllers: [AuditController],
})
export class AuditHttpModule {}
