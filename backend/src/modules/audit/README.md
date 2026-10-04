# Modul audit

## Tanggung jawab
Membaca log audit (PRD FR-USR-04). Baris ditulis hanya oleh trigger `audit_row()` di basis data; modul ini tidak pernah menulis.

## Tabel yang dimiliki
- `audit_log` (hanya tambah, terpartisi bulanan).

## Service publik
- `AuditService.list(ctx, { entityType, entityId }, cursor, limit)`.
- `AuditService.entriesIn(tx, targets, before, limit)`: entri beberapa entitas sekaligus di transaksi pemanggil, terbaru dulu (riwayat produk dan variannya, backend doc 8.23).

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/audit-logs?entity_type=&entity_id=&cursor=&limit=` | `audit:read` |

## Job
Ekspor bulanan ke R2 (`audit.export_monthly`) menyusul.
