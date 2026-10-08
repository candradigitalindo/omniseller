# Modul billing

## Tanggung jawab
Langganan, tagihan, kuota paket, dan meteran pesanan (PRD 14 dan 15.1, DOKUMEN-TEKNOLOGI ADR-020 dan ADR-040, layar L45, backend doc 8.32): uji coba Growth 14 hari untuk setiap bisnis baru, memilih paket, tagihan per periode yang dibayar lewat halaman Xendit, PDF tagihan dengan NPWP bisnis, perpanjangan, tenggang, turun ke Starter, dan peringatan pemakaian.

## Tabel yang dimiliki
- `subscription`, `invoice`, `usage_counter` (migrasi 0022); `invoice.bill_to` (migrasi 0023): salinan nama, alamat, dan NPWP bisnis saat tagihan dibayar.
- `plan` (global, seed) dan paket yang berlaku (`tenant.plan_id`) milik modul `identity`: dibaca dan diubah lewat `TenantsService.planIn | listPlansIn | planNamesIn | setPlanIn`. Hanya modul ini yang memanggil `setPlanIn`, selalu bersama baris langganan yang hidup.
- Nomor tagihan lewat `nextDocumentNumber` (jenis `invoice`, `INV-YYMM-NNNN`), pemberitahuan lewat `NotificationInboxService.notifyScopedIn`, data penagihan lewat `BusinessProfileService.billToIn`.

## Modul Nest
- `BillingModule` (api, worker, orders, reporting, exports): `BillingRepository`, `BillingService`, `UsageMeterService`. Hanya mengimpor `IdentityModule`, `NotificationInboxModule`, dan `BusinessModule` (yang tidak mengimpor billing atau pengimpornya), jadi modul yang mengimpornya tidak membentuk siklus.
- `BillingHttpModule` (api): `BillingOverviewService`, `InvoicePdfService`, dan `BillingController`; mengimpor channel dan inventory untuk menghitung toko dan gudang.
- `BillingWorkerModule` (worker): `XenditClient` (token `XENDIT`, dari env worker), `BillingWorkerService`, `InvoicePdfService`, dan `ReceiptAttachments`.
- `BillingWebhookModule` (proses webhook): `XenditWebhookController` (`POST /webhooks/xendit`, di luar OpenAPI) dan `XenditWebhookService`. Didaftarkan sebelum `WebhookHttpModule`, karena Express mencocokkan rute menurut urutan dan `POST /webhooks/{channel}` akan menangkapnya lebih dulu.

## Service publik
- `BillingService`:
  - `stateIn(tx, ctx, paymentsAvailable)`: langganan yang hidup (atau uji coba dari tanggal daftar bila barisnya belum ditulis), paket berikutnya, tagihan yang menunggu, periode berikutnya yang sudah dibayar;
  - `changePlan(ctx, planCode, paymentsAvailable)` dan `voidInvoice(ctx, id)` (api);
  - `startTrial`, `renew`, `applyCallback`, `markInvoiceCreated`, `markInvoiceFailed` (worker);
  - `taskIn(tx, ctx)` (dasbor), `invoicesIn`, `invoice`, `exportSheets` (`langganan.csv`, `tagihan.csv`).
- `UsageMeterService.countIn(tx, ctx, "orders", at)`: dipanggil `OrderIntakeService` di transaksi pesanan; `usageIn` untuk L45.
- `BillingWorkerService.createXenditInvoice` dan `expireXenditInvoice` (worker).
- `InvoicePdfService.document | render` (api dan worker): isi PDF tagihan dan PDF-nya.
- `ReceiptAttachments` (worker): didaftarkan ke `EmailAttachments` modul notifikasi; email `billing.reminder` beralasan `paid` atau `late_payment` membawa PDF tagihan `data.invoiceId`.
- `billing-plan.ts` (murni): `planChoice`, `upgradeCredit`, `upgradeStart`, `subscriptionStep`, `billingTask`, `usageWarning`, `lapsesAt`, `invoiceStatusOf`, nomor tagihan.
- `invoice-document.ts` (murni): `invoiceDocument` (judul, status, tanggal di zona waktu bisnis, penerbit, yang ditagih, baris paket dan potongan, total, catatan), `issuerParty`, `billToParty`, `paymentMethodText`, `invoiceFileName`; `invoice-pdf.ts`: `renderInvoicePdf` (satu halaman A4 dengan pdf-lib dan `common/pdf-text.ts`).
- `common/plan-limits.ts`: `limitReached` dan `planLimitReached` untuk modul pemilik tabel (identity, channel, inventory).

## Aturan
- Satu langganan hidup per bisnis (`trialing`, `active`, `past_due`; indeks unik parsial). Pindah paket mengakhiri baris lama (`cancelled`) dan memulai baris baru; tagihan yang membayarnya ikut dipindah ke baris baru.
- Naik paket berlaku saat dibayar, satu bulan sejak dibayar, dikurangi sisa periode berbayar (`credit_amount`, dihitung saat tagihan dibuat). Turun paket berlaku di akhir periode yang dibayar (`next_plan_id`). Uji coba: memilih Growth membuat tagihan bulan setelah uji coba. Tidak ada pengembalian dana.
- Tagihan perpanjangan dibuat 7 hari sebelum periode berakhir, untuk paket berikutnya bila dijadwalkan. Dibayar lebih awal, periodenya menunggu sampai mulai; dibayar dalam tenggang, langsung berlaku. Belum dibayar saat periode berakhir: `past_due` 7 hari dengan paket tetap berlaku, lalu Starter.
- Selama periode berikutnya sudah dibayar, perubahan paket ditolak (409 `billing.next_period_paid`).
- Setiap tagihan yang dibatalkan juga ditutup di Xendit (`billing.invoice_voided` → `billing.invoice_expire`). Uang untuk tagihan yang sudah tidak berlaku tetap dicatat lunas dan diumumkan (`late_payment`) tanpa mengubah paket.
- Xendit hanya dipanggil worker, tidak pernah di dalam transaksi. Api tidak memegang kunci Xendit; proses webhook hanya memegang Callback Verification Token.
- Kuota diperiksa modul pemilik tabel saat menambah (toko marketplace, gudang, pengguna dan undangan terbuka); yang sudah melebihi kuota setelah turun paket tidak dihapus. Pesanan tidak pernah ditolak karena kuota; meteran hanya memberi tahu pada 80% dan 100%.
- PDF tagihan (`GET /v1/billing/invoices/{id}/pdf`) dibuat api saat diminta, tidak disimpan: satu halaman, tanpa data dari luar. Tagihan yang lunas memuat `bill_to`, salinan profil bisnis yang ditulis `applyCallback` di transaksi yang mencatat pembayaran (juga pembayaran terlambat); tagihan lain, dan yang lunas sebelum salinan ada, memuat profil saat ini. `bill_to` tidak masuk log audit: profil asalnya diaudit sendiri.
- Penerbit tagihan dari env `BILLING_ISSUER_*` di api dan worker (nama wajib, bawaan "OmniSeller"; alamat, NPWP, email bila diisi). PDF bukan Faktur Pajak dan tidak memuat PPN.
- Email "Pembayaran ... diterima" (juga pembayaran yang datang untuk tagihan yang sudah tidak berlaku) membawa PDF tagihan sebagai lampiran, digambar worker saat email dikirim; tagihan yang hilang (tidak pernah diharapkan) membuat email terkirim tanpa lampiran.
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
| GET | `/v1/billing/invoices/{id}/pdf` (`application/pdf`, lampiran `<nomor>.pdf`) | `settings:billing` |
| POST | `/v1/billing/invoices/{id}/void` | `settings:billing` |
| POST | `/webhooks/xendit` (proses webhook) | `x-callback-token` |

## Keputusan khusus modul
- Satu tagihan per periode lewat Xendit Invoice API, bukan Recurring API: penjual membayar dengan virtual account, QRIS, atau e-wallet tanpa menyimpan kartu, dan aturan paket tetap di kode sendiri (ADR-040).
- `XenditClient` memakai `fetch` sendiri, bukan SDK `xendit-node`: tiga panggilan saja (`POST /v2/invoices`, `GET /v2/invoices/{id}`, `POST /invoices/{id}/expire!`), dan uji memakai Xendit tiruan (`test/setup/mock-xendit.ts`).
- Tagihan Xendit berisi satu item seharga yang dibayar; potongan disebut di deskripsi, karena Xendit tidak menerima item negatif.
- PDF tagihan digambar di api, seperti contoh template label: satu halaman dalam hitungan milidetik, jadi tidak perlu job, penyimpanan, atau masa berlaku berkas. Satu dokumen "TAGIHAN" untuk semua status; yang lunas diberi status "Lunas" dan berlaku sebagai bukti pembayaran.
- Belum termasuk: pengembalian dana, pembayaran berulang otomatis, pembatasan fitur per paket, kuota token AI dan tautan riset, kode promo dan referral, PPN, dan Faktur Pajak (e-Faktur lewat Coretax).

## Menguji tanpa akun Xendit
`pnpm mock:xendit` menjalankan Xendit tiruan (`test/setup/mock-xendit.ts`) di port 57480: Invoice API yang sama dengan kunci `xnd_development_test_key_000000`, dan halaman bayar dengan tombol "Bayar (simulasi)" yang mengirim callback lunas ke `http://127.0.0.1:3001/webhooks/xendit` (token `callback-verification-token-test`; ubah lewat `MOCK_XENDIT_CALLBACK_URL` dan `MOCK_XENDIT_CALLBACK_TOKEN`), lalu kembali ke aplikasi. Isi `.env.local` dengan `BILLING_PAYMENTS=xendit`, `XENDIT_API_BASE_URL=http://127.0.0.1:57480`, kunci, dan token itu, lalu jalankan `pnpm dev`. End-to-end di CI memakai cara yang sama.

## Menguji dengan akun Xendit mode uji
Integrasi yang sama berjalan dengan kunci mode uji; uang tidak benar-benar berpindah.
1. Di dashboard Xendit mode **Test**: Settings > Developers > API keys, buat secret key (diawali `xnd_development_`) dengan izin tulis untuk Invoices. Di Settings > Developers > Webhook settings, salin Callback Verification Token.
2. Proses webhook harus bisa dijangkau Xendit. Di komputer sendiri jalankan tunnel ke port proses webhook (bawaan 3001), misalnya `ngrok http 3001`, lalu daftarkan `<URL https tunnel>/webhooks/xendit` sebagai URL webhook Invoices (paid) di halaman yang sama. Di server, URL-nya `${PUBLIC_WEBHOOK_URL}/webhooks/xendit`.
3. `backend/.env.local`: `BILLING_PAYMENTS=xendit` (api), `XENDIT_SECRET_KEY=xnd_development_...` (worker), `XENDIT_WEBHOOK_TOKEN=<token>` (webhook), `XENDIT_API_BASE_URL=https://api.xendit.co`. Jalankan ulang `pnpm dev` (api, webhook, worker, scheduler).
4. Di web, Langganan & Tagihan: pilih paket berbayar, tunggu "Bayar sekarang" muncul (worker membuat halaman Xendit), lalu buka. Di halaman pembayaran mode uji pilih metode (misalnya virtual account) dan pakai tombol simulasi bayar di banner mode uji.
5. Periksa: tab Webhook di dashboard Xendit menunjukkan kiriman berstatus 200; log worker mencatat `billing.invoice_callback`; tagihan menjadi Lunas dan paket berganti; PDF tagihan memuat "Lunas", tanggal bayar, dan metodenya. Kiriman yang gagal bisa dikirim ulang dari tab Webhook.

Batas mode uji 60 permintaan per menit per endpoint. Bila callback tidak datang, periksa token (401 di log webhook) dan URL tunnel (berganti setiap ngrok dijalankan ulang tanpa domain tetap).
