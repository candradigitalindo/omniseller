# OmniSeller

Aplikasi manajemen penjualan multi-marketplace. Root repositori hanya berisi dokumen; setiap komponen berada di foldernya sendiri.

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

Menghubungkan toko marketplace butuh kunci aplikasi dari Shopee Open Platform dan TikTok Shop Partner Center (`SHOPEE_*`, `TIKTOKSHOP_*` di `.env.local`; penjelasannya di `.env.example`). Tanpa kunci, marketplace itu tampil "belum dikonfigurasi". Push dan webhook hanya sampai ke mesin lokal lewat tunnel yang diarahkan ke port 3001 (`PUBLIC_WEBHOOK_URL`). Uji integrasi tidak butuh kunci sungguhan: memakai server marketplace tiruan.

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

Setelah kontrak API berubah: `pnpm openapi:emit` di `backend/`, lalu `pnpm api:types` di `frontend/`.

Uji end-to-end (Playwright) berjalan terhadap backend dan web app yang sedang berjalan: `E2E_CHROME=1 pnpm e2e` di `frontend/`.

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
