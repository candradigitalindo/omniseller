# Modul business

## Tanggung jawab
Profil bisnis dan legalitasnya (PRD 6.13 dan 12, Permendag 19/2026; layar L47; backend doc 8.29): alamat, telepon, logo, NIB atau NIB yang sedang diurus (paling lama 6 bulan), NPWP, PKP, dan dokumen legalitas dengan masa berlakunya. Mengingatkan sebelum batas proses NIB atau masa berlaku dokumen habis.

## Tabel yang dimiliki
- `business_profile` (satu per bisnis, dibuat saat pertama disimpan) dan `business_document` (migrasi 0019).
- Nama bisnis dan zona waktu milik `identity` (`tenant`): dibaca dan diubah lewat `TenantsService.profileIn` dan `updateProfileIn`, di transaksi profil. Berkas lewat `FilesService` (tujuan `logo` dan `legal_document`), notifikasi lewat `NotificationInboxService.notifyScopedIn`.

## Service publik
- `BusinessProfileService`: `get`, `update`, `setLogo`, `removeLogo`, `logo`, `addDocument`, `updateDocument`, `removeDocument`, `documentFile` (api); `legalTasksIn` (dasbor, di transaksi pemanggil); `billToIn` (billing: nama, alamat, dan NPWP yang ditagih, disalin ke tagihan saat lunas); `buyerDataRetentionIn` (retention: masa simpan data pembeli dalam bulan, bawaan bila profil belum disimpan); `alertLegal` (worker); `exportSheets` (ekspor).
- `business-plan.ts` (murni): status NIB, batas proses (`nibDeadline`), status dokumen, tahap pengingat yang jatuh tempo, tugas dasbor, serta `formatNpwp` (NPWP 15 digit seperti di kartu, 16 digit apa adanya) dan `addressLines` (alamat untuk dokumen cetak).

## Aturan
- Semua endpoint `settings:billing` (Owner secara bawaan).
- NIB 13 angka atau tanggal mulai diurus, tidak keduanya; mengisi NIB mengakhiri proses. Tanggal mulai diurus tidak boleh setelah hari ini di zona waktu bisnis. Nomor (NIB, NPWP, telepon) disimpan sebagai angka saja.
- `PATCH /v1/business-profile` menerima `If-Match` dengan `rowVersion` (0 sebelum disimpan pertama kali). Mengganti nama atau zona waktu juga menaikkan versi profil, jadi satu ETag mencakup semuanya.
- Jenis berkas dibaca dari isinya (`common/file-type.ts`): logo PNG, JPG, atau WebP paling besar 1 MB; dokumen PDF, JPG, atau PNG paling besar 5 MB. Berkas yang diganti atau dihapus kedaluwarsa dan dihapus `files.cleanup_expired`.
- Masa simpan data pembeli (`buyer_data_retention_months`, migrasi 0025): 3 sampai 24 bulan, bawaan 24 (`DEFAULT_BUYER_DATA_RETENTION_MONTHS`, batas yang dijanjikan Kebijakan Privasi; situs publik mengujinya). Lewat masa itu modul retention menganonimkan data pembeli (backend doc 8.34). Perubahannya diaudit.
- Dokumen berlaku sampai akhir tanggal `valid_until`; `expiring` bila habis dalam 30 hari.
- Pengingat 30 hari, 7 hari, dan setelah lewat, masing-masing sekali (`reminded_stage`, `nib_reminded_stage`). Tahap yang terlewati tidak dikirim; yang terbaru saja. Tanggal berlaku baru atau tanggal mulai diurus yang baru mengosongkan tahapnya.

## Event
- Tidak ada.

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `business.legal_alert` | `notify` | Scheduler `business.legal_scan` (setiap jam, `scheduler/legal-scan.ts`) |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET, PATCH | `/v1/business-profile` | `settings:billing` |
| GET, PUT, DELETE | `/v1/business-profile/logo` | `settings:billing` |
| POST | `/v1/business-documents` | `settings:billing` (201) |
| PATCH, DELETE | `/v1/business-documents/{id}` | `settings:billing` (DELETE 204) |
| GET | `/v1/business-documents/{id}/file` | `settings:billing` |

## Keputusan khusus modul
- `tenant.legal` tidak dipakai; profil dan dokumen punya tabel sendiri agar bisa diaudit per kolom, diberi pengingat per dokumen, dan diekspor.
- Tahap pengingat tidak diaudit: trigger hanya memantau kolom yang dinyatakan penjual.
- Belum termasuk: memeriksa NIB atau NPWP ke OSS atau DJP, dan menaruh NPWP atau logo di dokumen yang dicetak.
