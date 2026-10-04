import {
  LISTING_DRAFT_STATUSES,
  ORDER_STATUSES,
  SHIPMENT_STATUSES,
  STOCK_ADJUSTMENT_REASONS,
  type StockMovementType,
} from "@omniseller/shared";
import { isoInZone } from "../../common/time-zone";
import { orderStatusLabel } from "../orders/orders.service";

const MOVEMENT_TYPES: Record<StockMovementType, string> = {
  order_reserve: "dipesan oleh pesanan (stok dipesan naik)",
  order_release: "pesanan batal atau berubah (stok dipesan turun)",
  order_ship: "barang pesanan keluar gudang",
  return_restock: "retur masuk kembali ke stok",
  return_quarantine: "retur masuk karantina",
  adjustment: "penyesuaian stok oleh pengguna",
  count_apply: "hasil stok opname",
  transfer_out: "transfer keluar ke gudang lain",
  transfer_in: "transfer masuk dari gudang lain",
  purchase_receipt: "penerimaan barang dari pemasok",
  quarantine_in: "masuk karantina",
  quarantine_out: "keluar karantina",
  campaign_hold: "ditahan untuk kampanye",
  campaign_release: "dilepas dari kampanye",
  migration_initial: "stok awal saat pindah ke OmniSeller",
};

const SHIPMENT_STATES: Record<(typeof SHIPMENT_STATUSES)[number], string> = {
  pending: "sedang diatur",
  arranged: "pickup atau drop-off sudah diatur",
  label_ready: "label siap dicetak",
  packed: "dikemas",
  handed_over: "diserahkan ke kurir",
  in_transit: "dalam perjalanan",
  delivered: "diterima pembeli",
  failed: "gagal kirim",
  rto_in_transit: "dikembalikan ke penjual",
  rto_received: "kembali diterima penjual",
  cancelled: "dibatalkan",
};

const DRAFT_STATES: Record<(typeof LISTING_DRAFT_STATUSES)[number], string> = {
  preparing: "sedang disiapkan ulang (kategori diganti)",
  draft: "menunggu ditinjau",
  publishing: "sedang diterbitkan",
  published: "sudah diterbitkan ke toko tujuan",
  failed: "gagal diterbitkan (lihat kolom galat)",
};

export interface ReadmeInput {
  business: string;
  timezone: string;
  at: Date;
  files: { name: string; rows: number; description: string }[];
}

/** README.txt at the top of the export ZIP: what each file holds and how to read it. */
export function exportReadme(p: ReadmeInput): string {
  const lines = [
    "EKSPOR DATA OMNISELLER",
    "",
    `Bisnis : ${p.business}`,
    `Dibuat : ${isoInZone(p.timezone, p.at)} (${p.timezone})`,
    "",
    "Semua berkas diambil dari satu titik waktu yang sama, jadi angkanya saling cocok.",
    "",
    "ISI",
    ...p.files.map((f) => `- ${f.name} (${f.rows} baris): ${f.description}`),
    "",
    "FORMAT",
    "- CSV dengan pemisah titik koma (;), UTF-8 dengan BOM, dan akhir baris CRLF: langsung terbuka per kolom",
    "  di Excel berbahasa Indonesia.",
    "- Waktu ditulis dalam zona waktu bisnis beserta selisihnya dari UTC, misalnya 2026-10-03T14:15:00+07:00.",
    "- Uang dalam rupiah, bilangan bulat tanpa pemisah ribuan. Ya/tidak ditulis ya dan tidak.",
    "- Teks yang diawali =, +, -, atau @ diberi awalan ' agar spreadsheet tidak menjalankannya sebagai rumus.",
    "- Kolom id menghubungkan berkas: item_pesanan.id_pesanan dan pengiriman.id_pesanan ke pesanan.id,",
    "  id_toko ke toko.id, id_gudang ke gudang.id, id_varian antara stok, mutasi_stok, listing, dan item_pesanan.",
    "- produk.csv memakai kolom templat impor produk, jadi bisa diimpor ulang ke OmniSeller.",
    "",
    "STATUS PESANAN (pesanan.status)",
    ...ORDER_STATUSES.map((s) => `- ${s}: ${orderStatusLabel(s)}`),
    "",
    "STATUS PENGIRIMAN (pengiriman.status)",
    ...SHIPMENT_STATUSES.map((s) => `- ${s}: ${SHIPMENT_STATES[s]}`),
    "",
    "STATUS DRAF SALINAN LISTING (draf_listing.status)",
    ...LISTING_DRAFT_STATUSES.map((s) => `- ${s}: ${DRAFT_STATES[s]}`),
    "",
    "JENIS MUTASI STOK (mutasi_stok.jenis)",
    ...Object.entries(MOVEMENT_TYPES).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "ALASAN PENYESUAIAN STOK (mutasi_stok.alasan)",
    ...Object.entries(STOCK_ADJUSTMENT_REASONS).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "Data keuangan (penarikan dana dan biaya marketplace) dan daftar pelanggan masuk ke ekspor ini begitu",
    "modulnya tersedia. Sampai saat itu nilai pesanan dan data pembeli ada di pesanan.csv.",
    "",
    "PERHATIAN: berkas ini berisi data pribadi pembeli (nama, telepon, alamat). Simpan di tempat aman dan",
    "hapus bila sudah tidak diperlukan.",
  ];
  return `${lines.join("\r\n")}\r\n`;
}
