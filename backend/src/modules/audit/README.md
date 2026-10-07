# Modul audit

## Tanggung jawab
Membaca log audit (PRD FR-USR-04, backend doc 8.28). Baris ditulis hanya oleh trigger `audit_row()` di basis data; modul ini tidak pernah menulis.

## Tabel yang dimiliki
- `audit_log` (hanya tambah, terpartisi bulanan).

## Berkas
- `audit.module.ts`: `AuditService` dan `AuditModule`. Modul lain (katalog, untuk riwayat produk) mengimpor berkas ini, jadi berkas ini tidak mengimpor modul lain.
- `audit-view.ts`: baris audit sebagai entri yang dibaca penjual (fungsi murni). Setiap tabel beraudit punya daftar field; kolom yang memicu trigger wajib ada di daftarnya (`audit-view.spec.ts` membaca `20_triggers.sql`).
- `audit-log.service.ts`, `audit.controller.ts`, `audit-http.module.ts`: log yang terbaca untuk api; nama rujukan dari service modul pemiliknya (paket lewat `TenantsService.planNamesIn`, rujukan `plan` untuk `subscription` dan `invoice`, backend doc 8.32).

## Service publik
- `AuditService.rowsIn(tx, filter, before, limit)`: baris dengan filter jenis, entitas, pelaku, dan waktu, terbaru dulu.
- `AuditService.entriesIn(tx, targets, before, limit)`: entri beberapa entitas sekaligus di transaksi pemanggil, terbaru dulu (riwayat produk dan variannya, backend doc 8.23).
- `AuditLogService.list(ctx, filter, cursor, limit)` dan `people(ctx)` (api saja).

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/audit-logs?entity_type=&entity_id=&actor_id=&from=&to=&cursor=&limit=` | `audit:read` |
| GET | `/v1/audit-logs/people` | `audit:read` |

## Job
Ekspor bulanan ke R2 (`audit.export_monthly`) menyusul.
