/**
 * Permission codes (`module:action`). This list is the source of truth; the `permission` table seed
 * (backend/drizzle/sql/90_seeds.sql) must contain exactly these codes, which the schema test verifies.
 */
export const PERMISSIONS = {
  "order:read": "Lihat pesanan",
  "order:accept": "Terima pesanan",
  "order:cancel": "Batalkan pesanan",
  "order:tag": "Beri tag pesanan",
  "order:write": "Buat dan ubah pesanan manual",
  "shipment:arrange": "Atur pengiriman dan pickup",
  "shipment:print": "Cetak label dan dokumen",
  "shipment:pack": "Kemas dengan scan",
  "shipment:handover": "Serah terima kurir",
  "inventory:read": "Lihat stok",
  "inventory:adjust": "Sesuaikan stok",
  "inventory:count": "Stock opname",
  "inventory:transfer": "Transfer stok",
  "catalog:read": "Lihat produk",
  "catalog:write": "Ubah produk",
  "catalog:publish": "Terbitkan produk ke toko",
  "catalog:map": "Hubungkan listing ke produk",
  "price:write": "Ubah harga",
  "promo:write": "Kelola promosi",
  "finance:read": "Lihat keuangan",
  "finance:reconcile": "Cocokkan dana cair",
  "finance:export": "Ekspor data keuangan",
  "chat:read": "Lihat chat",
  "chat:write": "Balas chat",
  "chat:assign": "Tugaskan chat",
  "report:read": "Lihat laporan",
  "settings:store": "Kelola toko terhubung",
  "settings:warehouse": "Kelola gudang, printer, dan kurir",
  "settings:user": "Kelola tim dan peran",
  "settings:billing": "Kelola langganan dan profil bisnis",
  "research:read": "Lihat riset pasar",
  "research:write": "Kelola riset pasar",
  "audit:read": "Lihat log audit",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const PERMISSION_CODES = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}

/** Built-in roles copied into every tenant at creation (PRD 4.3). */
export const SYSTEM_ROLES: Record<string, readonly Permission[]> = {
  Owner: PERMISSION_CODES,
  Admin: PERMISSION_CODES.filter((p) => p !== "settings:billing" && p !== "settings:user"),
  Gudang: [
    "order:read",
    "shipment:print",
    "shipment:pack",
    "shipment:handover",
    "inventory:read",
    "inventory:count",
    "catalog:read",
  ],
  CS: ["order:read", "order:tag", "chat:read", "chat:write", "catalog:read", "inventory:read"],
  Finance: [
    "order:read",
    "finance:read",
    "finance:reconcile",
    "finance:export",
    "report:read",
    "catalog:read",
    "inventory:read",
  ],
  Viewer: ["order:read", "inventory:read", "catalog:read", "report:read"],
};
