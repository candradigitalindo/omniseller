import type { CommerceInput, CommerceOperation } from "@omniseller/connector-core";
import type { RequestContext } from "../../common/context/request-context";
import { ForbiddenError, UnprocessableError, ValidationError } from "../../common/errors/domain-errors";
import { additionalCommercePermissions } from "./commerce-permissions";

/** Existing owning modules keep responsibility for local stock/order state and durable documents. */
const ownedMutation = /(?:inventory|update_stock|update_price|\/prices?\/|\/stock)/i;
const credentialOperation = /\/(?:authorization|token|auth)\//i;
const scopesUnavailable = "Dokumentasi izin operasi belum dapat diverifikasi. Operasi belum tersedia.";
export function publicOperation(operation: CommerceOperation): CommerceOperation {
  let reason = operation.unavailableReason;
  if (reason) {
    reason = /private upload sessions|dedicated large.video/i.test(reason)
      ? "Gunakan fitur unggah aset video berukuran besar yang terikat pada operasi tujuan."
      : /dedicated.*workflow|ledger|confirmation/i.test(reason)
        ? "Gunakan modul produk, stok, pesanan, pengiriman atau retur yang sesuai agar hasil tetap tersinkronisasi."
        : /binary|multipart|upload|file/i.test(reason)
          ? "Fitur ini memerlukan alur unggah atau unduh berkas yang belum tersedia di pusat commerce."
          : /region|market|global|cross.border/i.test(reason)
            ? "Fitur ini belum terverifikasi untuk akun dan wilayah Indonesia."
            : /scope/i.test(reason)
              ? scopesUnavailable
              : /authorization|private.assets|principal/i.test(reason)
                ? "Gunakan menu Integrasi atau Akun Creator & Partner untuk mengelola koneksi."
                : "Format permintaan fitur ini masih memerlukan verifikasi dokumentasi marketplace.";
  }
  if (credentialOperation.test(operation.path))
    reason = "Hubungkan akun melalui menu Integrasi atau Akun Creator & Partner.";
  else if (operation.write && ownedMutation.test(operation.path))
    reason = "Gunakan modul produk, stok, pesanan, pengiriman atau retur agar data operasional tetap konsisten.";
  else if (!operation.scopes.length && !(operation.channel === "shopee" && operation.authMode === "shopee_app_program"))
    reason = scopesUnavailable;
  return {
    ...operation,
    available: operation.available && !reason,
    unavailableReason: reason,
    requiredPermissions: commercePermissions(operation),
    ...(operation.eligibility
      ? {
          eligibilityReason:
            "Persetujuan aplikasi, program Indonesia, serta kecukupan izin dikonfirmasi kembali oleh marketplace saat permintaan dijalankan.",
        }
      : {}),
  };
}
export function domainPermission(operation: CommerceOperation): string {
  const path = operation.path;
  if (operation.transport === "private_download" && /logistics|shipping_document|booking/.test(path))
    return "shipment:print";
  if (/affiliate|creator|partner|showcase|collaboration|sample|\/ams\//.test(path))
    return operation.write ? "affiliate:write" : "affiliate:read";
  if (/finance|payment|settlement|statement|transaction|reconciliation/.test(path))
    return operation.write ? "finance:reconcile" : "finance:read";
  if (/customer_service|conversation|message|chat/.test(path)) return operation.write ? "chat:write" : "chat:read";
  if (
    /promotion|discount|campaign|coupon|voucher|\/ads\/|shop_flash_sale|add_on_deal|bundle_deal|follow_prize|top_picks/.test(
      path,
    )
  )
    return operation.write ? "promo:write" : "catalog:read";
  if (/analytics|performance|data_compass|account_health|shop_health/.test(path)) return "report:read";
  if (/return|refund/.test(path)) return operation.write ? "return:respond" : "order:read";
  if (/order|fulfillment|logistics/.test(path)) return operation.write ? "shipment:arrange" : "order:read";
  if (/fbt|fbs/.test(path)) return operation.write ? "shipment:arrange" : "inventory:read";
  if (/product|category|brand|inventory|stock/.test(path)) return operation.write ? "catalog:write" : "catalog:read";
  return "settings:store";
}
export function authorizeCommercePermissions(ctx: RequestContext, operation: CommerceOperation) {
  const permissions = commercePermissions(operation);
  if (permissions.some((permission) => !ctx.permissions.has(permission)))
    throw new ForbiddenError("commerce.permission_required", "Izin operasi commerce dan modul terkait diperlukan.");
  // Generic responses have no proven warehouse-level filter; a restricted warehouse role cannot read them.
  if (ctx.warehouseScope !== null)
    throw new ForbiddenError("commerce.warehouse_scope", "Operasi ini memerlukan akses seluruh gudang bisnis.");
}
function commercePermissions(operation: CommerceOperation): string[] {
  return [
    ...new Set([
      "commerce:read",
      ...(operation.write ? ["commerce:write"] : []),
      domainPermission(operation),
      ...(operation.principalKind === "seller" ? [] : ["affiliate:account_read"]),
      ...additionalCommercePermissions(operation),
    ]),
  ];
}
export function authorizeOperation(ctx: RequestContext, operation: CommerceOperation, scopes: string[]) {
  authorizeCommercePermissions(ctx, operation);
  if (!operation.available)
    throw new UnprocessableError("commerce.unavailable", operation.unavailableReason ?? scopesUnavailable);
  // This check is necessary, not sufficient: the marketplace enforces its applicable grant/program.
  if (
    operation.authMode !== "shopee_app_program" &&
    (operation.scopeMode === "any"
      ? !operation.scopes.some((scope) => scopes.includes(scope))
      : operation.scopes.some((scope) => !scopes.includes(scope)))
  )
    throw new UnprocessableError(
      "commerce.scope_required",
      "Akun belum memberikan izin API yang diperlukan. Periksa persetujuan aplikasi dan hubungkan ulang.",
    );
}
export function authorizeCommerceInput(ctx: RequestContext, operation: CommerceOperation, input: CommerceInput) {
  if (!operation.write || !/(?:^\/product\/|^\/api\/v2\/(?:product|global_product)\/)/.test(operation.path)) return;
  const inspect = (value: unknown, path: string) => {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (/stock|inventory/i.test(key))
        throw new ValidationError([
          {
            path: `${path}.${key}`,
            message: "Perubahan stok harus melalui modul Stok agar jumlah lokal dan marketplace tetap konsisten.",
          },
        ]);
      if (/price/i.test(key) && !ctx.permissions.has("price:write"))
        throw new ForbiddenError("commerce.price_permission", "Izin ubah harga diperlukan untuk field harga produk.");
      inspect(entry, `${path}.${key}`);
    }
  };
  inspect(input.body, "input.body");
}
