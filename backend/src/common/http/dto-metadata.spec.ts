import "reflect-metadata";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";
import { describe, expect, it } from "vitest";
import { AuditController } from "../../modules/audit/audit.module";
import { AuthController } from "../../modules/auth/auth.controller";
import { ListingsController, ProductsController } from "../../modules/catalog/catalog.controllers";
import {
  ChannelsController,
  StoreAuthorizationsController,
  StoresController,
} from "../../modules/channel/channel.controllers";
import { ExportsController } from "../../modules/exports/exports.controller";
import { FilesController } from "../../modules/files/files.controller";
import { DocumentsController, ShipmentsController } from "../../modules/fulfillment/fulfillment.controllers";
import {
  InvitationsController,
  MeController,
  RolesController,
  UsersController,
} from "../../modules/identity/identity.controllers";
import {
  InventoryController,
  StockRulesController,
  WarehousesController,
} from "../../modules/inventory/inventory.controllers";
import { NotificationsController } from "../../modules/notification/inbox.controller";
import { OrdersController } from "../../modules/orders/orders.controllers";
import { HealthController } from "../../modules/platform/health.controller";
import { DashboardController } from "../../modules/reporting/reporting.controller";
import { WebhooksController } from "../../modules/sync/webhooks.controller";

/**
 * Guards the contract the validation pipe relies on: every @Body, @Query, and @Param parameter must
 * be typed with a nestjs-zod DTO class *at runtime* (decorator metadata). If a DTO is imported with
 * `import type` (or `type X` inside an import), the compiler erases it, the metadata becomes Object,
 * and every request to that route fails with a 500. Add new controllers to this list.
 */
const CONTROLLERS = [
  HealthController,
  AuthController,
  MeController,
  UsersController,
  RolesController,
  InvitationsController,
  AuditController,
  ChannelsController,
  StoreAuthorizationsController,
  StoresController,
  WarehousesController,
  InventoryController,
  StockRulesController,
  WebhooksController,
  ProductsController,
  ListingsController,
  OrdersController,
  ShipmentsController,
  DocumentsController,
  FilesController,
  NotificationsController,
  DashboardController,
  ExportsController,
];

/** Same test nestjs-zod's pipe applies (its helper is not exported from the package root). */
function isZodDto(t: unknown): boolean {
  return typeof t === "function" && (t as { isZodDto?: unknown }).isZodDto === true;
}

const VALIDATED = new Set<number>([RouteParamtypes.BODY, RouteParamtypes.QUERY, RouteParamtypes.PARAM]);

describe("controller parameter metadata", () => {
  it("types every validated parameter with a nestjs-zod DTO at runtime", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const controller of CONTROLLERS) {
      for (const method of Object.getOwnPropertyNames(controller.prototype)) {
        const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) as
          | Record<string, { index: number }>
          | undefined;
        if (!args) continue;
        const types = (Reflect.getMetadata("design:paramtypes", controller.prototype, method) ?? []) as unknown[];
        for (const [key, { index }] of Object.entries(args)) {
          const paramType = Number(key.split(":")[0]);
          if (!VALIDATED.has(paramType)) continue;
          checked++;
          if (!isZodDto(types[index])) {
            problems.push(
              `${controller.name}.${method} parameter ${index} is ${(types[index] as { name?: string })?.name}`,
            );
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(problems).toEqual([]);
  });
});
