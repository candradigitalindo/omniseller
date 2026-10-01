import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from "../../common/errors/domain-errors";

const CHANNEL_NAMES: Record<string, string> = { shopee: "Shopee", tiktokshop: "Tokopedia & Shop" };
const nameOf = (channel: string) => CHANNEL_NAMES[channel] ?? channel;

export const storeNotFound = () => new NotFoundError("store.not_found", "Toko tidak ditemukan.");
export const authorizationNotFound = () =>
  new NotFoundError("store_authorization.not_found", "Permintaan hubungkan toko tidak ditemukan.");
export const channelNotConfigured = (channel: string) =>
  new UnprocessableError("channel.not_configured", `Koneksi ke ${nameOf(channel)} belum diaktifkan di OmniSeller.`);
export const channelUnsupported = (channel: string) =>
  new UnprocessableError("channel.unsupported", `Marketplace ${channel} belum didukung.`);
export const authorizationInvalid = () =>
  new UnprocessableError(
    "store_authorization.invalid",
    "Tautan otorisasi ini tidak berlaku lagi. Mulai hubungkan toko dari awal.",
  );
export const reauthorizeChannelMismatch = () =>
  new ValidationError([{ path: "storeId", message: "Toko ini berasal dari marketplace lain." }]);
export const storeNotActive = () =>
  new ConflictError("store.not_active", "Toko ini belum terhubung. Hubungkan ulang toko terlebih dahulu.");
export const storeAlreadyDisconnected = () => new ConflictError("store.disconnected", "Toko ini sudah diputus.");
export const storeUnmappedWarehouses = (count: number) =>
  new ConflictError(
    "store.unmapped_warehouses",
    `Masih ada ${count} gudang marketplace yang belum dipetakan. Petakan semua gudang sebelum mengaktifkan sinkron stok.`,
  );
export const channelWarehouseNotFound = () =>
  new NotFoundError("channel_warehouse.not_found", "Gudang marketplace tidak ditemukan.");
export const marketplaceManagedWarehouse = () =>
  new ConflictError(
    "channel_warehouse.marketplace_managed",
    "Gudang ini dikelola marketplace, stoknya tidak diatur dari gudang Anda.",
  );
export const warehouseNotFound = (path: string) =>
  new ValidationError([{ path, message: "Gudang tidak ditemukan atau tidak aktif." }]);

/**
 * Why a connection attempt failed, stored on store_authorization.error_code and shown to the seller.
 * These are outcomes of a background job, not HTTP errors.
 */
export const AUTHORIZATION_FAILURES = {
  denied: "Otorisasi dibatalkan di halaman marketplace.",
  expired: "Waktu otorisasi habis. Mulai hubungkan toko dari awal.",
  exchange_failed: "Marketplace menolak kode otorisasi. Mulai hubungkan toko dari awal.",
  no_supported_shop: "Akun ini tidak punya toko Indonesia yang bisa dihubungkan.",
  shop_connected_elsewhere:
    "Toko ini sudah terhubung ke bisnis lain di OmniSeller. Putuskan dulu dari bisnis tersebut.",
  store_mismatch: "Akun yang diotorisasi bukan toko yang ingin dihubungkan ulang.",
  marketplace_error: "Marketplace sedang bermasalah. Coba hubungkan lagi beberapa saat lagi.",
} as const;
export type AuthorizationFailure = keyof typeof AUTHORIZATION_FAILURES;

/** Why a store left `active`, stored on store.status_reason. */
export const STORE_STATUS_REASONS = {
  authorization_revoked: "Seller mencabut izin OmniSeller di marketplace.",
  authorization_expired: "Masa izin OmniSeller di marketplace sudah habis.",
  authorization_expiring: "Masa izin OmniSeller di marketplace akan segera habis.",
  refresh_failed: "Token toko gagal diperbarui beberapa kali berturut-turut.",
  shop_banned: "Toko sedang dibekukan oleh marketplace.",
  disconnected_by_user: "Toko diputus oleh pengguna.",
} as const;
export type StoreStatusReason = keyof typeof STORE_STATUS_REASONS;
