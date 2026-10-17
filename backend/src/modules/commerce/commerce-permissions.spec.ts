import type { CommerceOperation } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { systemContext } from "../../common/context/request-context";
import { visibleCommerceData } from "./commerce-permissions";
import { authorizeCommercePermissions, publicOperation } from "./commerce-policy";

const operation = (path: string): CommerceOperation => ({
  id: "reviewed",
  channel: "shopee",
  principalKind: "seller",
  title: "Reviewed operation",
  group: "Ads",
  method: "GET",
  path,
  scopes: [],
  authMode: "shopee_app_program",
  write: false,
  officialUrl: "https://open.shopee.com",
  fields: [],
  available: true,
  unavailableReason: null,
});

describe("commerce financial visibility", () => {
  const owner = systemContext("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  const limited = {
    ...owner,
    permissions: new Set([...owner.permissions].filter((permission) => permission !== "finance:read")),
  };
  it.each([
    "/api/v2/ads/get_total_balance",
    "/api/v2/ams/get_validation_list",
    "/api/v2/ams/get_validation_report",
    "/affiliate_creator/202405/affiliate_orders",
    "/finance/202309/withdrawals",
  ])("protects financial facts from non-finance roles: %s", (path) => {
    const op = operation(path);
    expect(() => authorizeCommercePermissions(limited, op)).toThrow("Izin operasi");
    expect(() => authorizeCommercePermissions(owner, op)).not.toThrow();
    expect(publicOperation(op).requiredPermissions).toContain("finance:read");
  });
  it("keeps catalog prices and affiliate rates visible with the domain permission", () => {
    expect(() =>
      authorizeCommercePermissions(limited, operation("/api/v2/ams/get_open_campaign_added_product")),
    ).not.toThrow();
    expect(visibleCommerceData(limited, { price: "25000", commission_rate: 5 })).toEqual({
      price: "25000",
      commission_rate: 5,
    });
  });
  it("requires finance export permission for a private affiliate financial report", () => {
    const report = {
      ...operation("/affiliate_seller/202603/compass/offline_tasks/{task_id}/file"),
      transport: "private_download" as const,
    };
    expect(publicOperation(report).requiredPermissions).toEqual(
      expect.arrayContaining(["finance:read", "finance:export"]),
    );
    const noExport = {
      ...owner,
      permissions: new Set([...owner.permissions].filter((permission) => permission !== "finance:export")),
    };
    expect(() => authorizeCommercePermissions(noExport, report)).toThrow("Izin operasi");
  });
  it("redacts nested cost and derived facts after the caller's finance permission changes", () => {
    const data = {
      products: [
        {
          price: "25000",
          unitCost: "15000",
          gross_profit: "10000",
          profit_rate: 40,
          metrics: { stock_value: "100000", roi: 2, orders: 3 },
        },
      ],
    };
    expect(visibleCommerceData(owner, data)).toBe(data);
    expect(visibleCommerceData(limited, data)).toEqual({
      products: [
        {
          price: "25000",
          unitCost: null,
          gross_profit: null,
          profit_rate: null,
          metrics: { stock_value: null, roi: null, orders: 3 },
        },
      ],
    });
    expect(data.products[0]!.unitCost).toBe("15000");
  });
});
