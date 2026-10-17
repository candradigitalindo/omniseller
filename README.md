# OmniSeller

Integrator commerce multi-marketplace untuk seller, creator dan affiliate partner. Root repositori hanya berisi dokumen; setiap komponen berada di foldernya sendiri.

Pusat **Fitur Commerce** (`/commerce`) menyediakan operasi seller Shopee dan Tokopedia & Shop serta creator/affiliate partner Indonesia melalui koneksi marketplace yang diotorisasi. Inbox `/commerce/pesan`, creator Shopee Video/LIVE dan pemasangan Tokopedia & Shop dari App Store tersedia dengan pemeriksaan role serta identitas toko. Tenant menghubungkan akun melalui consent platform; API key aplikasi saja tidak memberi seluruh izin. [Matriks operasi executable](IMPLEMENTASI-COMMERCE-OPERASI.csv) dan [status implementasi](IMPLEMENTASI-MARKETPLACE.md) membedakan kontrak lokal, alur khusus, batas program dan sandbox nyata yang belum tersedia.

| Dokumen | Isi |
|---|---|
| `DOKUMEN-SPESIFIKASI-APLIKASI.md` | PRD: apa yang dibangun |
| `DOKUMEN-TEKNOLOGI.md` | Keputusan teknologi dan ADR |
| `DOKUMEN-ARSITEKTUR-BACKEND.md` | Cara backend dibangun: skema, invarian, langkah pengembangan |
| `DOKUMEN-UI-UX.md`, `DOKUMEN-UI-UX-MOBILE.md` | Sistem desain dan spesifikasi layar |
| `AGENTS.md` | Kontrak singkat untuk agen AI dan engineer |

## Struktur

```
backend/     NestJS (api, webhook, worker, scheduler), migrasi SQL, paket shared, logging, dan connector marketplace
frontend/    Next.js: web app penjual
print-agent/ Electron: agen cetak Windows dan macOS, antrean SQLite dan tray
website/     situs publik statis: beranda, harga, kontak, dan kebijakan (tanpa dependensi)
mobile/      Expo (menyusul)
```

## Backend

Butuh Node.js 24, pnpm 10, dan salah satu dari: Docker, atau PostgreSQL 15+ dan Redis terpasang langsung. Semua perintah dijalankan dari folder `backend/`.

```bash
cd backend
pnpm install
pnpm infra:up                  # dengan Docker
pnpm infra:native start        # tanpa Docker (PostgreSQL 127.0.0.1:5433, Redis 6379 dan 6380)
cp .env.example .env.local
pnpm db:bootstrap              # membuat empat role basis data dan database
pnpm db:migrate                # migrasi, fungsi, trigger, RLS, grant, seed, partisi
pnpm dev                       # api :3000, webhook :3001, worker, scheduler
```

Setiap tenant dapat menyimpan aplikasi marketplace sendiri melalui **Toko Terhubung → Pengaturan marketplace**. Kredensial aplikasi tidak perlu diisi di `.env.local` untuk alur ini. Push dan webhook hanya sampai ke mesin lokal lewat tunnel yang diarahkan ke port 3001 (`PUBLIC_WEBHOOK_URL`). Uji integrasi tidak butuh kunci sungguhan: memakai transport marketplace tiruan bertanda tangan.

### Kredensial marketplace per tenant

Pengguna dengan izin `settings:store` dan cakupan seluruh toko/gudang bisnis mengisi kredensial melalui modal **Pengaturan marketplace**. Satu aplikasi per marketplace dipakai oleh toko dan akun creator/partner tenant tersebut, sesuai izin program yang diberikan platform.

| Marketplace | Kolom pada pengaturan tenant | Sumber |
|---|---|---|
| Shopee | Partner ID, Partner Key, pilihan Produksi/Sandbox | Aplikasi di [Shopee Open Platform](https://open.shopee.com/) |
| Tokopedia & Shop | App Key, App Secret, Service ID | Aplikasi/layanan di [TikTok Shop Partner Center](https://partner.tiktokshop.com/) |

Secret disimpan terenkripsi, tidak dikembalikan oleh API dan tidak ditampilkan ulang pada formulir. Penyimpanan berlaku langsung tanpa restart backend. Putuskan seluruh koneksi toko dan akun creator/partner marketplace serta selesaikan otorisasi yang berjalan sebelum mengganti atau menghapus key. Penghapusan tidak otomatis beralih ke aplikasi bawaan pengelola.

Setelah menyimpan, buka **Alamat callback** dan salin redirect/webhook persis ke konsol aplikasi developer. Webhook berbentuk `${PUBLIC_WEBHOOK_URL}/webhooks/{channel}/apps/{applicationId}`. Redirect Tokopedia & Shop menyertakan `?application_id=...` untuk mengikat instalasi App Store ke tenant yang tepat; pertahankan parameter ini saat mendaftarkannya. Lalu pilih **Hubungkan toko** dan berikan persetujuan OAuth. Tokopedia & Shop memerlukan **Service ID** selain App Key/Secret untuk tautan izin seller. Menyimpan key belum membuktikan validitas akun atau persetujuan program.

Domain/protokol callback harus sesuai ketentuan platform. Untuk pengujian lokal yang memerlukan HTTPS publik, gunakan domain tunnel pada `PUBLIC_WEB_URL` dan akses web app melalui domain itu. `PUBLIC_WEBHOOK_URL` mengarah ke proses webhook port 3001. Pilihan Sandbox Shopee menggunakan host sandbox resmi; akun uji Tokopedia & Shop mengikuti pengaturan uji Partner Center.

Environment tetap menyimpan konfigurasi infrastruktur: staging/produksi membutuhkan `MARKETPLACE_APP_ENCRYPTION_KEY` (32 byte acak, base64) yang konsisten pada api/webhook/worker dan disimpan bersama cadangan database. Lokal/test menurunkan kunci terpisah dari kunci TOTP yang sudah ada jika variabel tersebut kosong; jangan mengganti material enkripsi setelah menyimpan kredensial. `SHOPEE_*` dan `TIKTOKSHOP_*` tetap tersedia sebagai aplikasi bawaan opsional untuk tenant yang belum mempunyai pengaturan sendiri. Jangan memasukkan secret ke chat atau Git. Detail keputusan: [ADR-050](backend/docs/adr/0050-tenant-marketplace-applications.md).

Pengujian:

```bash
pnpm lint && pnpm typecheck
pnpm test                      # unit
pnpm test:int                  # integrasi: basis data dan Redis sungguhan
```

`pnpm test:int` memakai `TEST_PG_ADMIN_URL` (URL superuser ke database `postgres`) dan `TEST_REDIS_URL` bila diset, dan Testcontainers bila tidak. Setiap run membuat database baru dan menjalankan tes dengan role aplikasi (bukan superuser), sehingga RLS dan grant ikut teruji. Contoh tanpa Docker:

```bash
TEST_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5433/postgres TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm test:int
```

Paket di `backend/packages` (shared, connector) dipakai backend lewat hasil build-nya (`dist`). Setelah mengubah kode paket, jalankan `pnpm build:packages` (sudah termasuk dalam `pnpm test:int`) sebelum menjalankan satu berkas uji integrasi dengan `vitest run --project integration`. Tanpa itu, tes memakai kode paket yang lama.

Perintah operasional backend (replay webhook, perbaikan push stok, pemeliharaan partisi, rotasi DEK, purge yang sudah waktunya, dan daftar/retry job gagal) ada di [backend/src/ops/README.md](backend/src/ops/README.md). Semua menyediakan pratinjau; operasi tenant mengikuti outbox dan worker.

## Web app

Butuh backend yang berjalan (`pnpm dev` di `backend/`, api di port 3000). Semua perintah dari folder `frontend/`; rinciannya di `frontend/README.md`.

```bash
cd frontend
pnpm install
cp .env.example .env.local     # API_ORIGIN, bawaan http://localhost:3000
pnpm dev                       # http://localhost:3100
pnpm lint && pnpm typecheck && pnpm test
```

Setelah kontrak API berubah: `pnpm openapi:emit` di `backend/`, lalu `pnpm api:types` di `frontend/` dan `print-agent/`.

Uji end-to-end (Playwright) berjalan terhadap backend dan web app yang sedang berjalan: `E2E_CHROME=1 pnpm e2e` di `frontend/`.

## Agen cetak desktop

Implementasi M51 berada di [print-agent/README.md](print-agent/README.md). Pairing memakai token dari Pengaturan → Printer di web; pilihan printer thermal/A4, halaman percobaan, antrean tahan restart, dan konfirmasi hasil yang belum pasti tersedia dari tray. Jalankan `pnpm install && pnpm dev` dari `print-agent/`; `pnpm dist:win` dan `pnpm dist:mac` membuat installer internal. Rilis publik membutuhkan sertifikat penandatanganan dan feed HTTPS, dijelaskan di README komponen.

## CI

`.github/workflows/ci.yml` menjalankan lint, typecheck, unit, dan uji integrasi backend (PostgreSQL dan Redis sebagai service), pemeriksaan web app, dan uji end-to-end terhadap stack yang dibangun di runner. Workflow ini berjalan setelah repositori didorong ke GitHub.

## Situs publik

Halaman publik (beranda, harga, kontak, Syarat Layanan, Kebijakan Privasi, Kebijakan Pengembalian Dana) dibangun dari `website/site.json` menjadi HTML statis yang bisa di-host gratis. Butuh Node.js 22 atau lebih baru, tanpa `pnpm install`. Rinciannya di `website/README.md`.

```bash
cd website
node build.mjs --strict        # dist/; gagal selama site.json masih berisi [ISI: ...]
node serve.mjs                 # pratinjau di http://127.0.0.1:4173
node --test "test/*.test.mjs"
```
