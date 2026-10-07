# Modul billing

## Tanggung jawab
Langganan, tagihan, kuota paket, dan meteran pesanan (PRD 14 dan 15.1, DOKUMEN-TEKNOLOGI ADR-020 dan ADR-040, layar L45, backend doc 8.32): uji coba Growth 14 hari untuk setiap bisnis baru, memilih paket, tagihan per periode yang dibayar lewat halaman Xendit, perpanjangan, tenggang, turun ke Starter, dan peringatan pemakaian.

## Tabel yang dimiliki
- `subscription`, `invoice`, `usage_counter` (migrasi 0022).
- `plan` (global, seed) dan paket yang berlaku (`tenant.plan_id`) milik modul `identity`: dibaca dan diubah lewat `TenantsService.planIn | listPlansIn | planNamesIn | setPlanIn`. Hanya modul ini yang memanggil `setPlanIn`, selalu bersama baris langganan yang hidup.
- Nomor tagihan lewat `nextDocumentNumber` (jenis `invoice`, `INV-YYMM-NNNN`), pemberitahuan lewat `NotificationInboxService.notifyScopedIn`.

## Modul Nest
- `BillingModule` (api, worker, orders, reporting, exports): `BillingRepository`, `BillingService`, `UsageMeterService`. Hanya mengimpor `IdentityModule` dan `NotificationInboxModule`, jadi modul yang mengimpornya tidak membentuk siklus.
- `BillingHttpModule` (api): `BillingOverviewService` dan `BillingController`; mengimpor channel dan inventory untuk menghitung toko dan gudang.
- `BillingWorkerModule` (worker): `XenditClient` (token `XENDIT`, dari env worker) dan `BillingWorkerService`.
- `BillingWebhookModule` (proses webhook): `XenditWebhookController` (`POST /webhooks/xendit`, di luar OpenAPI) dan `XenditWebhookService`. Didaftarkan sebelum `WebhookHttpModule`, karena Express mencocokkan rute menurut urutan dan `POST /webhooks/{channel}` akan menangkapnya lebih dulu.

## Service publik
- `BillingService`:
  - `stateIn(tx, ctx, paymentsAvailable)`: langganan yang hidup (atau uji coba dari tanggal daftar bila barisnya belum ditulis), paket berikutnya, tagihan yang menunggu, periode berikutnya yang sudah dibayar;
  - `changePlan(ctx, planCode, paymentsAvailable)` dan `voidInvoice(ctx, id)` (api);
  - `startTrial`, `renew`, `applyCallback`, `markInvoiceCreated`, `markInvoiceFailed` (worker);
  - `taskIn(tx, ctx)` (dasbor), `invoicesIn`, `invoice`, `exportSheets` (`langganan.csv`, `tagihan.csv`).
- `UsageMeterService.countIn(tx, ctx, "orders", at)`: dipanggil `OrderIntakeService` di transaksi pesanan; `usageIn` untuk L45.
- `BillingWorkerService.createXenditInvoice` dan `expireXenditInvoice` (worker).
- `billing-plan.ts` (murni): `planChoice`, `upgradeCredit`, `upgradeStart`, `subscriptionStep`, `billingTask`, `usageWarning`, `lapsesAt`, `invoiceStatusOf`, nomor tagihan.
- `common/plan-limits.ts`: `limitReached` dan `planLimitReached` untuk modul pemilik tabel (identity, channel, inventory).

## Aturan
- Satu langganan hidup per bisnis (`trialing`, `active`, `past_due`; indeks unik parsial). Pindah paket mengakhiri baris lama (`cancelled`) dan memulai baris baru; tagihan yang membayarnya ikut dipindah ke baris baru.
- Naik paket berlaku saat dibayar, satu bulan sejak dibayar, dikurangi sisa periode berbayar (`credit_amount`, dihitung saat tagihan dibuat). Turun paket berlaku di akhir periode yang dibayar (`next_plan_id`). Uji coba: memilih Growth membuat tagihan bulan setelah uji coba. Tidak ada pengembalian dana.
- Tagihan perpanjangan dibuat 7 hari sebelum periode berakhir, untuk paket berikutnya bila dijadwalkan. Dibayar lebih awal, periodenya menunggu sampai mulai; dibayar dalam tenggang, langsung berlaku. Belum dibayar saat periode berakhir: `past_due` 7 hari dengan paket tetap berlaku, lalu Starter.
- Selama periode berikutnya sudah dibayar, perubahan paket ditolak (409 `billing.next_period_paid`).
- Setiap tagihan yang dibatalkan juga ditutup di Xendit (`billing.invoice_voided` → `billing.invoice_expire`). Uang untuk tagihan yang sudah tidak berlaku tetap dicatat lunas dan diumumkan (`late_payment`) tanpa mengubah paket.
- Xendit hanya dipanggil worker, tidak pernah di dalam transaksi. Api tidak memegang kunci Xendit; proses webhook hanya memegang Callback Verification Token.
- Kuota diperiksa modul pemilik tabel saat menambah (toko marketplace, gudang, pengguna dan undangan terbuka); yang sudah melebihi kuota setelah turun paket tidak dihapus. Pesanan tidak pernah ditolak karena kuota; meteran hanya memberi tahu pada 80% dan 100%.
- Semua endpoint `settings:billing` (Owner secara bawaan).

## Event
- Diterbitkan: `billing.invoice_requested`, `billing.invoice_voided` (`billing.events.ts`).
- Dikonsumsi: `tenant.created` (identity).

## Job (antrean `billing`)
| Job | Pemicu |
|---|---|
| `billing.trial_start` | `tenant.created`; pemindai untuk bisnis tanpa baris langganan |
| `billing.invoice_create` | `billing.invoice_requested` |
| `billing.invoice_expire` | `billing.invoice_voided` |
| `billing.invoice_callback` | Proses webhook (`XenditWebhookService`), id dari `webhook-id` Xendit |
| `billing.renew` | Scheduler `billing.renewal_scan` (setiap jam, `scheduler/billing-scan.ts`) |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET, POST | `/v1/billing/subscription` | `settings:billing` (POST 200) |
| GET | `/v1/billing/invoices`, `/v1/billing/invoices/{id}` | `settings:billing` |
| POST | `/v1/billing/invoices/{id}/void` | `settings:billing` |
| POST | `/webhooks/xendit` (proses webhook) | `x-callback-token` |

## Keputusan khusus modul
- Satu tagihan per periode lewat Xendit Invoice API, bukan Recurring API: penjual membayar dengan virtual account, QRIS, atau e-wallet tanpa menyimpan kartu, dan aturan paket tetap di kode sendiri (ADR-040).
- `XenditClient` memakai `fetch` sendiri, bukan SDK `xendit-node`: tiga panggilan saja (`POST /v2/invoices`, `GET /v2/invoices/{id}`, `POST /invoices/{id}/expire!`), dan uji memakai Xendit tiruan (`test/setup/mock-xendit.ts`).
- Tagihan Xendit berisi satu item seharga yang dibayar; potongan disebut di deskripsi, karena Xendit tidak menerima item negatif.
- Belum termasuk: PDF tagihan dan bukti bayar dengan NPWP, pengembalian dana, pembayaran berulang otomatis, pembatasan fitur per paket, kuota token AI dan tautan riset, kode promo dan referral, serta PPN.
