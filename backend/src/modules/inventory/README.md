# Modul inventory

## Tanggung jawab
Gudang, stok, pergerakan stok, stock opname, transfer, dan aturan alokasi (PRD 6.3). Saat ini baru sisi baca gudang; sisanya menyusul di tahap stok.

## Tabel yang dimiliki
- `warehouse`, `inventory`, `stock_movement`, `stock_allocation_rule`, `stock_count`, `stock_count_line`, `stock_transfer`, `stock_transfer_line`, `campaign_stock_hold`.

## Service publik
- `WarehousesService.list(ctx)`: gudang dalam cakupan gudang pengguna.
- `WarehousesService.activeIn(tx)`, `findActiveIn(tx, id)`: dipakai modul lain di dalam transaksinya (misalnya modul channel untuk pemetaan gudang marketplace), agar tidak ada modul lain yang membaca tabel `warehouse` langsung.

## Aturan
- Jumlah stok hanya berubah lewat `apply_stock_movement()` dan `ensure_inventory()` (invarian I2).
- Gudang pertama (`UTAMA`, "Gudang Utama") dibuat modul identity saat bisnis mendaftar, sampai pembuatan gudang tersedia di modul ini.

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/warehouses` | `inventory:read` |
