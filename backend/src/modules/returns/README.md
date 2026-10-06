# Modul returns

## Tanggung jawab
Pengajuan pembeli setelah membeli (PRD FR-RET-01, 02, 03, 06, 07; backend doc 8.26): retur dan refund serta permintaan pembatalan dari Shopee dan Tokopedia & Shop, keputusan penjual yang dikirim ke marketplace beserta foto bukti, penerimaan barang retur ke stok jual atau karantina, dan paket yang kembali karena pesanan dibatalkan setelah dikirim (RTO). Pintu masuknya layar L09 "Retur & Batal".

## Tabel yang dimiliki
- `return_request`: satu pengajuan marketplace (retur, refund, penggantian, penukaran, pembatalan) atau satu paket kembali (`rto`), dengan status, tenggat, keputusan yang tersedia, keputusan penjual, dan penerimaannya.
- `return_item`: unit satu baris pesanan dalam pengajuan, dan jumlah yang diterima layak jual, rusak, atau tidak diterima.
- Membaca dan mengubah pesanan lewat `OrdersService` dan `OrderIntakeService` (orders), stok lewat `InventoryService.returnMovementsIn` (inventory), toko lewat `StoresService` (channel), foto lewat `FilesService` (files), notifikasi lewat `NotificationInboxService`. Tidak pernah menyentuh tabel modul lain.

## Modul Nest
- `ReturnsModule` (api dan worker): `ReturnsRepository`, `ReturnsService`.
- `ReturnsWorkerModule` (worker): `ReturnSyncService` (memakai `MarketplaceGateway` dari `ChannelWorkerModule` global dan `OrderSyncService` untuk pesanan yang belum terbaca), `ReturnAlertsService`.
- `ReturnsHttpModule` (api): `ReturnsController`.

## Service publik
- `ReturnsService`:
  - `list(ctx, filter, before, limit)` (tab: `group`, `awaitingDecision`, `toReceive`), `summary`, `get`;
  - `requestRefresh` (baca ulang dari marketplace lewat worker);
  - `addEvidence(ctx, id, base64)`: foto JPEG atau PNG paling besar 5 MB, disimpan privat 180 hari, paling banyak 20 per pengajuan;
  - `respond(ctx, id, "accept" | "reject", input)`: keputusan diperiksa terhadap pilihan dari marketplace, lalu dikirim worker;
  - `receive(ctx, id, {warehouseId?, note?, items})`: sekali per pengajuan;
  - modul lain: `deleteStoreReturnsIn` (retention), `exportSheets()` (`retur.csv`, `retur_barang.csv`), `requestsOfItemsIn` (pengajuan dan nomor pesanan per baris retur dalam cakupan, kartu stok 8.13);
  - `awaitsSeller(row)`: pengajuan menunggu keputusan penjual sekarang.
  - Error: `return.not_found`, `return.not_marketplace` (RTO tidak ditanggapi), `return.response_pending`, `return.decisions_stale` (pilihan keputusan sedang dibaca ulang), `return.nothing_to_decide`, `return.already_received`, `return.no_goods`, `return.evidence_limit`, validasi (`decision`, `reason`, `email`, `evidence...`, `items...`, `warehouseId`, `content`); dari channel `store.not_active`; `store.read_only` untuk toko mode paralel.
- Hanya worker:
  - `ReturnSyncService`: `pull`, `refreshReturns` (webhook), `followCancellations`, `refreshRequest`, `respond`, `openRto`, `applyAll`;
  - `ReturnAlertsService`: `notifyNew`, `alertDue`.

## Aturan
- Proses api tidak memanggil marketplace: pilihan keputusan (`decisions`) dibaca worker untuk status marketplace saat itu (`decisions_for`) dan disimpan; yang kedaluwarsa (status sudah berubah) ditolak 409 sampai dibaca ulang.
- Status mengikuti marketplace ke mana pun di antara status terbuka; `refunded`, `cancelled`, dan `closed` final, kecuali marketplace membuka pengajuan lagi (Shopee: pembeli meminta batal dua kali pada pesanan yang sama). Keputusan murni ada di `return-plan.ts` dengan uji unit.
- Snapshot yang lebih tua dari `external_updated_at` diabaikan.
- Barang dicocokkan ke baris pesanan per varian listing (dan item bila marketplace menyebutnya); unit yang tersebar di beberapa baris (grup promosi Shopee) mengisi baris berurutan; sisanya tanpa baris.
- Pembatalan hanya dibuat saat masih menunggu penjual; selebihnya hanya diperbarui. Permintaan batal Shopee adalah pesanan berstatus IN_CANCEL (id-nya nomor pesanan).
- "Menunggu keputusan" punya satu definisi untuk tampilan (`awaitsSeller`), tab dan penghitung, dan peringatan tenggat (`AWAITING` di repository): pengajuan marketplace terbuka yang menunggu keputusan atau tenggatnya berjalan, belum dijawab untuk status marketplace saat ini atau jawabannya gagal, dan tidak sedang dikirim.
- Satu keputusan per pengajuan dalam perjalanan (`response_status = pending`); tiap keputusan adalah percobaan baru dengan kunci idempoten TikTok Shop `<id>-<attempt>`. Email kontak sanggahan Shopee dihapus begitu terkirim atau gagal.
- Penerimaan mengunci pesanan sebelum baris stok, seperti perubahan pesanan sendiri. Layak jual: `return_restock` (stok tersedia naik dan didorong ke marketplace); rusak: `return_quarantine` (stok rusak, tidak dijual). SKU yang belum dipetakan hanya bisa dicatat tidak diterima.
- Pesanan yang dipenuhi gudang marketplace tidak mengirim barang ke gudang penjual (`goods_return` false).
- Data pribadi pembeli yang ikut dalam jawaban marketplace (email, nama, alamat penjemputan Shopee) tidak pernah dibaca connector; alasan pembeli tidak dicatat di log maupun audit.
- Pengajuan terlihat bila tokonya dalam cakupan toko pengguna dan gudangnya dalam cakupan gudang pengguna; toko yang diputus disembunyikan dari daftar.

## Event
- Diterbitkan: `return.pull_requested` (lanjutan halaman), `return.refresh_requested`, `return.respond_requested`.
- Dikonsumsi: `store.connected`, `order.return_started`, `order.cancel_request_changed`, `order.cancelled_after_shipping`; webhook `return.changed`.

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `return.pull` | `mp.poll` | `store.connected` (30 hari), `return.pull_requested`, `order.return_started`, scheduler `mp.poll.returns` tiap 10 menit |
| `return.refresh` | `mp.poll` | `return.refresh_requested` |
| `return.respond` | `mp.outbound` | `return.respond_requested`; id `return.respond\|<id>\|<attempt>`; gagal setelah 5 percobaan |
| `return.cancellation_follow` | `mp.poll` | `order.cancel_request_changed` |
| `return.rto_open` | `order.ingest` | `order.cancelled_after_shipping` |
| `return.new_notice` | `notify` | scheduler `return.new_scan` tiap 5 menit |
| `return.due_alert` | `notify` | scheduler `return.due_scan` tiap 15 menit |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/returns`, `/v1/returns/summary`, `/v1/returns/{id}` | `order:read` |
| POST | `/v1/returns/{id}/refresh`, `/v1/returns/{id}/evidence`, `/v1/returns/{id}/accept`, `/v1/returns/{id}/reject` | `return:respond` |
| POST | `/v1/returns/{id}/receive` | `return:receive` |

## Keputusan khusus modul
- Status pesanan tidak diubah oleh pengajuan, kecuali pesanan `return_in_progress` yang semua unit terkirimnya sudah diterima kembali menjadi `returned`. Shopee sendiri memindahkan pesanan ke TO_RETURN; TikTok Shop tidak punya status retur untuk pesanan, jadi untuk Tokopedia & Shop layar retur adalah tempatnya.
- Shopee tidak mengirim push untuk retur: pengajuan dibaca setiap 10 menit dan segera setelah push pesanan berstatus TO_RETURN.
- Tidak termasuk: tawaran refund sebagian (Shopee `offer`, TikTok Shop `OFFER_PARTIAL_REFUND`), unggah bukti kirim untuk retur yang diatur penjual (Shopee TW/BR), kompensasi Shopee, Batch Return TikTok Shop (RMA), dan laporan tingkat retur (FR-RET-05).
