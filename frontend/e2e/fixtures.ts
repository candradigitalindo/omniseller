import { test as base, expect, type Page } from "@playwright/test";

/**
 * A client address per test. The api limits signups per address (5 an hour, backend 8.10) and reads it from
 * CF-Connecting-IP, which only Cloudflare sets in production; every test here is its own client.
 */
function clientIp(): string {
  const r = () => Math.floor(Math.random() * 250) + 1;
  return `10.${r()}.${r()}.${r()}`;
}

export type Business = { email: string; password: string; name: string };

/** Every test runs as a new business, signed in, so tests share nothing and can run side by side. */
export const test = base.extend<{ business: Business }>({
  context: async ({ context }, use) => {
    await context.setExtraHTTPHeaders({ "cf-connecting-ip": clientIp() });
    await use(context);
  },
  business: async ({ page }, use, info) => {
    const stamp = `${Date.now().toString(36)}${info.workerIndex}${Math.floor(Math.random() * 1e4)}`;
    const business = { email: `e2e-${stamp}@example.test`, password: "E2e-kata-sandi-2026", name: `Toko E2E ${stamp}` };
    const res = await page.request.post("/v1/auth/signup", {
      data: { businessName: business.name, name: "Rina Wulandari", email: business.email, password: business.password },
    });
    expect(res.status(), await res.text()).toBe(201);
    await use(business);
  },
});

export { expect };

/** The api through the page's own cookies, for setting up data a test is not about. */
export async function call<T = unknown>(
  page: Page,
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  data?: unknown,
): Promise<T> {
  const res = await page.request.fetch(path, { method, ...(data === undefined ? {} : { data }) });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

type Variant = { id: string; sku: string };
export type Shop = {
  warehouseId: string;
  storeId: string;
  variants: Record<"black" | "white" | "tumbler", Variant>;
  order: { id: string; number: string };
};

/**
 * A small shop: one product with two variants and a tumbler, stock in the business's first warehouse, a
 * manual sales channel, and one paid manual order for J&T (2 black shirts and a tumbler).
 */
export async function seedShop(page: Page, tag: string): Promise<Shop> {
  const warehouseId = (await call<{ items: { id: string }[] }>(page, "GET", "/v1/warehouses")).items[0]!.id;
  const shirt = await call<{ variants: Variant[] }>(page, "POST", "/v1/products", {
    sku: `KAOS-${tag}`,
    name: "Kaos Polos Cotton Combed 30s",
    attributeNames: ["Warna"],
    variants: [
      {
        sku: `KAOS-${tag}-HTM`,
        name: "Hitam",
        attributes: { Warna: "Hitam" },
        barcode: null,
        basePrice: 65_000,
        costPrice: 35_000,
        weightG: 200,
      },
      {
        sku: `KAOS-${tag}-PTH`,
        name: "Putih",
        attributes: { Warna: "Putih" },
        basePrice: 65_000,
        costPrice: 35_000,
        weightG: 200,
      },
    ],
  });
  const tumbler = await call<{ variants: Variant[] }>(page, "POST", "/v1/products", {
    sku: `TMB-${tag}`,
    name: "Tumbler Stainless 500 ml",
    variants: [{ sku: `TMB-${tag}-500`, basePrice: 120_000, costPrice: 70_000, weightG: 450 }],
  });
  const [black, white] = shirt.variants as [Variant, Variant];
  const bottle = tumbler.variants[0]!;
  await call(page, "POST", "/v1/inventory/adjustments", {
    reason: "correction",
    note: "stok awal e2e",
    lines: [
      { variantId: black.id, warehouseId, mode: "set", quantity: 50 },
      { variantId: white.id, warehouseId, mode: "set", quantity: 20 },
      { variantId: bottle.id, warehouseId, mode: "set", quantity: 10 },
    ],
  });
  const store = await call<{ id: string }>(page, "POST", "/v1/stores/manual", { name: "WhatsApp" });
  const order = await call<{ id: string; externalOrderId: string }>(page, "POST", "/v1/orders/manual", {
    storeId: store.id,
    buyer: { name: "Dewi Anggraini", phone: "081234567801" },
    shippingAddress: { line1: "Jl. Melati No. 5", city: "Kota Bandung", province: "Jawa Barat", postalCode: "40132" },
    shippingProvider: "J&T Express",
    items: [
      { variantId: black.id, qty: 2 },
      { variantId: bottle.id, qty: 1 },
    ],
    shippingFee: 12_000,
    discount: 0,
    paymentMethod: "transfer",
    paid: true,
  });
  return {
    warehouseId,
    storeId: store.id,
    variants: { black, white, tumbler: bottle },
    order: { id: order.id, number: order.externalOrderId },
  };
}

/** A short, unique tag for SKUs, so tests never collide even in one business. */
export function tag(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
