import { type CommerceInput, type CommerceValue, PermanentConnectorError } from "@omniseller/connector-core";

const object = (value: unknown): value is Record<string, CommerceValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (message: string): never => {
  throw new PermanentConnectorError({ code: "commerce_invalid_input", message });
};
const present = (value: unknown) => value !== undefined && value !== null && value !== "";

/** Reviewed conditional requirements are evaluated after the static wire whitelist. */
export function validateShopeeCommerceConstraints(operationId: string, input: CommerceInput): void {
  const body = input.body ?? {};
  if (/^shopee\.bundle_deal\.(?:add|update)_bundle_deal$/.test(operationId)) {
    const rule = body.rule_type;
    if (rule !== undefined) {
      if (rule !== 1 && rule !== 2 && rule !== 3) invalid("Pilih aturan bundel yang tersedia.");
      const field = rule === 1 ? "fix_price" : rule === 2 ? "discount_percentage" : "discount_value";
      if (!present(body[field])) invalid("Isi nilai diskon atau harga yang sesuai dengan aturan bundel.");
      const tiers = body.additional_tiers;
      const entries = Array.isArray(tiers) ? tiers : object(tiers) ? [tiers] : [];
      for (const tier of entries) {
        if (object(tier) && !present(tier[field])) invalid("Isi nilai setiap tingkatan sesuai aturan bundel.");
      }
    }
    if (
      operationId.endsWith(".add_bundle_deal") &&
      typeof body.start_time === "number" &&
      typeof body.end_time === "number" &&
      body.end_time < body.start_time + 3600
    )
      invalid("Waktu akhir bundel minimal satu jam setelah waktu mulai.");
  }
  if (/^shopee\.discount\.(?:add|update)_discount_item$/.test(operationId)) {
    for (const item of Array.isArray(body.item_list) ? body.item_list : []) {
      if (!object(item)) continue;
      const models = item.model_list;
      if (!Array.isArray(models) && !present(item.item_promotion_price))
        invalid("Isi harga promo produk atau daftar harga promo varian.");
    }
  }
  if (/^shopee\.shop_flash_sale\.(?:add|update)_shop_flash_sale_items$/.test(operationId)) {
    for (const item of Array.isArray(body.items) ? body.items : []) {
      if (!object(item)) continue;
      if (Array.isArray(item.models)) {
        if (present(item.item_input_promo_price) || present(item.item_stock) || present(item.item_status))
          invalid("Gunakan pengaturan varian untuk produk yang memiliki varian.");
      } else if (operationId.endsWith(".add_shop_flash_sale_items")) {
        if (!present(item.item_input_promo_price) || !present(item.item_stock))
          invalid("Isi harga promo dan kuota kampanye untuk produk tanpa varian.");
      } else if (!present(item.item_status)) {
        invalid("Pilih status flash sale untuk produk tanpa varian.");
      }
    }
  }
  if (operationId === "shopee.logistics.create_shipping_document_job") {
    const sku = Array.isArray(body.unpackaged_sku_requests) && body.unpackaged_sku_requests.length > 0;
    const packages = Array.isArray(body.package_list) && body.package_list.length > 0;
    if (sku === packages) invalid("Pilih daftar SKU atau daftar paket untuk dokumen pengiriman.");
    if (sku) {
      const quantity = (body.unpackaged_sku_requests as CommerceValue[]).reduce<number>(
        (sum, item) => sum + (object(item) && typeof item.quantity === "number" ? item.quantity : 0),
        0,
      );
      if (quantity > 600) invalid("Jumlah seluruh salinan label maksimal 600.");
    }
  }
  if (operationId === "shopee.logistics.update_operating_hours") {
    const hours = (entry: CommerceValue, depth = 0): void => {
      if (depth > 10) return;
      if (Array.isArray(entry)) {
        for (const child of entry) hours(child, depth + 1);
        return;
      }
      if (!object(entry)) return;
      for (const [key, child] of Object.entries(entry)) {
        if (key === "start_time" || key === "end_time") {
          if (
            typeof child !== "string" ||
            (!/^(?:[01][0-9]|2[0-3]):(?:00|30)$/.test(child) && !(key === "end_time" && child === "23:59"))
          )
            invalid("Jam operasional harus memakai menit 00 atau 30; pukul akhir 23.59 juga tersedia.");
        } else if (["date", "start_date", "end_date"].includes(key)) {
          if (typeof child !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(child))
            invalid("Tanggal operasional tidak valid.");
          const date = new Date(`${child}T00:00:00.000Z`);
          if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== child)
            invalid("Tanggal operasional tidak valid.");
        }
        hours(child, depth + 1);
      }
    };
    hours(body);
  }
  if (operationId === "shopee.logistics.update_channel") {
    const settings = body.auto_call_driver_setting;
    if (object(settings) && settings.auto_call_driver_enabled === true && !present(settings.preparation_time))
      invalid("Isi waktu persiapan ketika panggilan kurir otomatis diaktifkan.");
  }
  if (operationId === "shopee.order.handle_prescription_check") {
    if (!present(body.pharmacist_name)) invalid("Isi nama apoteker untuk pesanan resep Indonesia.");
    if (body.is_approved === false && !present(body.reject_reason_code)) invalid("Pilih alasan penolakan resep.");
    if (body.reject_reason_code === 5 && !present(body.free_text)) invalid("Isi penjelasan penolakan resep.");
  }
  const walk = (entry: CommerceValue, depth = 0): void => {
    if (depth > 10) return;
    if (Array.isArray(entry)) {
      for (const child of entry) walk(child, depth + 1);
      return;
    }
    if (!object(entry)) return;
    const preOrder = entry.pre_order;
    if (object(preOrder) && preOrder.is_pre_order === true && !present(preOrder.days_to_ship))
      invalid("Isi waktu pengiriman untuk produk pre-order.");
    if (Array.isArray(entry.field_list)) {
      for (const field of entry.field_list) {
        if (!object(field)) continue;
        if (field.field_type === "text" && !present(field.text)) invalid("Isi teks deskripsi produk.");
        if (field.field_type === "image" && (!object(field.image_info) || !present(field.image_info.image_id)))
          invalid("Pilih gambar untuk bagian deskripsi bergambar.");
      }
    }
    for (const child of Object.values(entry)) walk(child, depth + 1);
  };
  if (/^shopee\.product\./.test(operationId)) walk(body);
}
