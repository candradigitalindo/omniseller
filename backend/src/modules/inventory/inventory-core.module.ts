import { Module } from "@nestjs/common";
import { InventoryRepository } from "./inventory.repository";
import { InventoryService } from "./inventory.service";
import { WarehousesService } from "./warehouses.service";

const CORE = [InventoryRepository, WarehousesService, InventoryService];

/**
 * Warehouses and quantities (api and worker). The channel and catalog modules depend on this one, so
 * this file imports neither: a cycle between the module files would hand Nest an undefined import.
 * Stock features that read listings and stores live in inventory.module.ts.
 */
@Module({ providers: CORE, exports: CORE })
export class InventoryModule {}
