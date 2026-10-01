import { Controller, Get, Inject, Module } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ulidSchema } from "@omniseller/shared";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { WarehousesService } from "./warehouses.service";

const warehouseSchema = z.object({
  id: ulidSchema,
  code: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  active: z.boolean(),
  address: z.record(z.string(), z.unknown()),
});
export class WarehouseListDto extends createZodDto(z.object({ items: z.array(warehouseSchema) })) {}

@ApiTags("warehouses")
@Controller("v1/warehouses")
@RequirePermission("inventory:read")
export class WarehousesController {
  constructor(@Inject(WarehousesService) private readonly warehouses: WarehousesService) {}

  /** Warehouses of the business, limited to the caller's warehouse scope. */
  @Get()
  @Isolation({ fixture: "warehouse" })
  @ZodResponse({ type: WarehouseListDto })
  async list(@Ctx() ctx: RequestContext) {
    return { items: await this.warehouses.list(ctx) };
  }
}

/** Inventory services (worker and api). Stock movements and counts join this module later. */
@Module({ providers: [WarehousesService], exports: [WarehousesService] })
export class InventoryModule {}

@Module({ imports: [InventoryModule], controllers: [WarehousesController] })
export class InventoryHttpModule {}
