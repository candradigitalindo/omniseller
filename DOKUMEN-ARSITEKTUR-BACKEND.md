# OmniSeller — Dokumen Arsitektur dan Pengembangan Backend

| Item | Keterangan |
|---|---|
| Versi dokumen | 1.3 |
| Tanggal | 1 Oktober 2026 |
| Status | Keputusan final untuk implementasi; fondasi (bagian 4 sampai 9, 12, 13) serta identitas, autentikasi, dan audit (8.1, 8.10, 10.6) sudah diimplementasikan di folder `backend/` |
| Pemilik dokumen | Candra Syahputra |
| Dokumen terkait | DOKUMEN-SPESIFIKASI-APLIKASI.md (PRD) versi 1.9, DOKUMEN-TEKNOLOGI.md versi 1.4 |
| Audiens | Engineer backend, tech lead, QA, dan **agen AI** yang mengerjakan basis kode |

> **Untuk agen AI yang membaca dokumen ini.** Bacalah bagian 2 terlebih dahulu. Bagian itu berisi kontrak kerja: invarian yang tidak boleh dilanggar, tempat setiap hal berada, dan urutan langkah untuk setiap jenis perubahan. Semua nama tabel, kolom, modul, antrean, dan perintah di dokumen ini adalah nama yang sebenarnya dipakai di repositori. Jangan menebak nama; cari di dokumen ini atau di kode.

---

## Daftar Isi

1. [Tujuan dan Cara Membaca](#1-tujuan-dan-cara-membaca)
2. [Kontrak untuk Agen AI dan Engineer](#2-kontrak-untuk-agen-ai-dan-engineer)
3. [Gambaran Arsitektur Backend](#3-gambaran-arsitektur-backend)
4. [Struktur Proyek Backend](#4-struktur-proyek-backend)
5. [Lingkungan dan Konfigurasi](#5-lingkungan-dan-konfigurasi)
6. [Identitas Rekaman: ULID](#6-identitas-rekaman-ulid)
7. [Desain Basis Data](#7-desain-basis-data)
8. [Lapisan Aplikasi](#8-lapisan-aplikasi)
9. [Pekerjaan Latar dan Penjadwalan](#9-pekerjaan-latar-dan-penjadwalan)
10. [Aturan API](#10-aturan-api)
11. [Peta Modul dan Kepemilikan Tabel](#11-peta-modul-dan-kepemilikan-tabel)
12. [Migrasi Basis Data](#12-migrasi-basis-data)
13. [Pengujian Backend](#13-pengujian-backend)
14. [Observabilitas dan Keamanan di Kode](#14-observabilitas-dan-keamanan-di-kode)
15. [Panduan Pengembangan Langkah demi Langkah](#15-panduan-pengembangan-langkah-demi-langkah)
16. [Runbook Operasional](#16-runbook-operasional)
17. [Lampiran Kode dan Berkas](#17-lampiran-kode-dan-berkas)
18. [Glosarium dan Riwayat](#18-glosarium-dan-riwayat)

---

## 1. Tujuan dan Cara Membaca

Dokumen ini menetapkan **bagaimana backend OmniSeller dibangun**: struktur proyek, lingkungan, skema basis data beserta relasi dan batasannya, lapisan aplikasi, pekerjaan latar, dan langkah pengembangan. Dokumen ini melengkapi PRD (apa yang dibangun) dan Dokumen Teknologi (teknologi apa yang dipakai).

Tiga sasaran yang membentuk setiap keputusan di sini:

1. **Kesalahan data tidak mungkin, bukan sekadar jarang.** Integritas ditegakkan oleh basis data: kunci asing komposit yang menyertakan tenant, batasan CHECK, trigger transisi status, dan fungsi tunggal untuk mengubah stok. Bug di kode aplikasi tidak boleh menghasilkan data yang rusak.
2. **Dapat dikerjakan oleh siapa pun, termasuk agen AI.** Setiap modul memiliki bentuk yang sama, setiap perubahan memiliki urutan langkah yang sama, dan setiap nama mengikuti konvensi yang sama. Tidak ada pengetahuan tersembunyi di kepala satu orang.
3. **Dapat diskalakan tanpa menulis ulang.** Batas modul, antrean, dan partisi sudah dirancang untuk volume sepuluh kali lipat dari target Fase 3.

Urutan baca yang disarankan:

| Pembaca | Urutan |
|---|---|
| Engineer baru | 2, 3, 4, 5, 15.1 sampai 15.3, lalu 7 dan 8 sambil membuka kode |
| Agen AI yang diberi tugas | 2, lalu bagian yang dirujuk tabel 2.3 sesuai jenis tugas |
| Peninjau kode | 2.2 (invarian), 7.1 sampai 7.7, 15.11 (checklist PR) |
| DevOps | 5, 12, 16 |

---

## 2. Kontrak untuk Agen AI dan Engineer

### 2.1 Aturan dasar

1. Jangan menebak. Nama tabel, kolom, modul, antrean, dan perintah ada di dokumen ini dan di kode. Bila tidak ditemukan di keduanya, berarti belum ada dan harus dibuat mengikuti konvensi bagian 4, 7, dan 8.
2. Setiap perubahan mengikuti urutan langkah di bagian 15 untuk jenisnya (modul baru, tabel baru, endpoint baru, job baru, connector baru).
3. Setiap perubahan disertai tes sesuai bagian 13. Perubahan tanpa tes tidak digabung.
4. Setiap keputusan yang menyimpang dari dokumen ini dicatat sebagai ADR di `docs/adr/` dan dokumen ini diperbarui pada PR yang sama.
5. Kode dan komentar dalam bahasa Inggris. Teks yang dilihat pengguna dalam bahasa Indonesia lewat berkas i18n.
6. Gunakan perintah `pnpm` yang terdaftar di 17.9. Jangan memanggil alat secara langsung dengan opsi yang berbeda dari skrip.

### 2.2 Invarian yang tidak boleh dilanggar

| # | Invarian | Cara ditegakkan | Yang harus dilakukan agen |
|---|---|---|---|
| I1 | Tidak ada query data tenant di luar `withTenantTx` | RLS mengembalikan nol baris tanpa `app.tenant_id`; lint Semgrep menolak `db.` di luar helper | Selalu bungkus akses data dengan `withTenantTx(handle, ctx, tx => ...)` |
| I2 | Stok hanya berubah lewat `apply_stock_movement()` | Role `omniseller_api` dan `omniseller_worker` tidak punya hak INSERT, DELETE, atau UPDATE kolom jumlah pada `inventory` dan `stock_movement`; fungsi `SECURITY DEFINER` memeriksa tenant; trigger `inventory_guard` sebagai lapis kedua | Panggil `InventoryService.applyMovement()`; jangan pernah `UPDATE inventory` untuk kolom jumlah |
| I3 | Status hanya berubah sesuai tabel transisi | Trigger `enforce_status_transition('<tabel>')` di `order`, `shipment`, `sync_job` (dan tabel berstatus lain saat dibuat) | Gunakan `<Modul>Service.transition(...)`; fakta dari marketplace di dalam `withStatusSource(tx, 'marketplace', ...)` |
| I4 | Setiap efek samping keluar (marketplace, email, WhatsApp, AI) lewat outbox dan BullMQ | Tidak ada klien HTTP keluar di proses `api`; lint menolak impor connector di `src/modules/*/controller.ts` | Tulis `outbox_event` di transaksi yang sama, biarkan relay dan worker mengeksekusi |
| I5 | Setiap tabel memiliki `id` ULID, `tenant_id`, `created_at`, `updated_at`, `row_version` (kecuali tabel global dan tabel hanya-tambah yang dicatat di `test/schema`) | Uji skema `pnpm test:schema` membaca katalog PostgreSQL | Tulis kolom standar di migrasi SQL; cermin Drizzle memakai `baseColumns()` |
| I6 | Kunci asing ke tabel milik tenant selalu komposit `(tenant_id, x_id)`, dan `ON DELETE SET NULL` selalu menyebut kolomnya: `SET NULL (x_id)` | Uji skema memeriksa setiap FK termasuk daftar kolom `SET NULL` | Tulis FK komposit di migrasi SQL (7.3, 7.4) |
| I7 | Uang selalu `bigint` rupiah utuh | Tipe kolom dan util `Money` | Jangan pernah memakai `numeric` atau `float` untuk uang |
| I8 | Data pribadi pembeli tidak masuk log, tidak masuk skema `research`, tidak dikirim ke AI tanpa disamarkan | Redaksi di logger, tidak ada FK dari `research` ke `order`, `PiiScrubber` sebelum panggilan AI | Gunakan `logger` dari `@omniseller/logging`, bukan `console` |
| I9 | Perubahan skema mengikuti expand and contract | Tinjauan migrasi wajib | Jangan `DROP`, `RENAME`, atau ubah tipe di rilis yang sama dengan perubahan kode yang bergantung |
| I10 | Setiap job BullMQ idempoten dan `jobId` deterministik | Helper `jobKey()` (pemisah `\|`, BullMQ menolak `:`) dan konvensi di 9.2 | Bangun `jobId` dari kunci bisnis; untuk aksi yang boleh berulang pada entitas yang sama, sertakan kunci kejadian (id outbox atau skor debounce) |
| I11 | Webhook receiver hanya verifikasi, simpan, enqueue, balas | Tidak ada modul bisnis dimuat di proses `webhook` | Jangan menambah logika di `src/webhook/` |
| I12 | Token marketplace hanya dapat dibaca dan ditulis proses `worker` dan `scheduler` | `omniseller_api` hanya punya SELECT kolom metadata `store_credential`, tanpa INSERT atau UPDATE; hak KMS hanya untuk worker dan scheduler | Penukaran kode OAuth dan enkripsi token dikerjakan job di worker (8.6); jangan memuat `CredentialService` di proses `api` |

### 2.3 Peta cepat: jenis tugas ke bagian dokumen

| Jenis tugas | Baca | Langkah |
|---|---|---|
| Menambah modul baru | 4, 8, 11 | 15.4 |
| Menambah atau mengubah tabel | 6, 7 | 15.5 |
| Menambah endpoint | 8, 10 | 15.6 |
| Menambah job atau jadwal | 9 | 15.7 |
| Menambah connector marketplace | 8.7, 9, DOKUMEN-TEKNOLOGI 8 | 15.8 |
| Menambah event domain dan consumer | 8.5, 8.6 | 15.9 |
| Memperbaiki bug data | 7, 16 | 16 |
| Menjalankan lokal | 5 | 15.2, 15.3 |

### 2.4 Tempat setiap hal berada

Seluruh kode backend berada di folder `backend/` di root repositori (ADR-032); root hanya berisi dokumen. **Semua path di dokumen ini relatif terhadap `backend/`**, dan semua perintah `pnpm` dijalankan dari sana.

| Hal | Lokasi |
|---|---|
| Migrasi SQL berversi (sumber kebenaran DDL dan batasan) | `drizzle/migrations/NNNN_nama.sql` |
| SQL repeatable: fungsi, trigger, kebijakan RLS, grant, seed | `drizzle/sql/NN_nama.sql` (dijalankan ulang setiap `db:migrate`, harus idempoten) |
| Cermin skema Drizzle (tipe query) | `src/db/schema/<domain>.ts`, dijaga sama dengan SQL oleh `pnpm test:schema` |
| Migrator dan bootstrap role | `src/db/migrate.ts`, `src/db/bootstrap.ts` |
| Modul bisnis | `src/modules/<nama>/` |
| Definisi job dan skema payload | `src/modules/<modul>/<modul>.jobs.ts`, didaftarkan di `src/jobs/registry.ts` |
| Jadwal | `src/scheduler/schedules.ts` |
| Connector | `packages/connectors/<marketplace>/` |
| Tipe domain dan skema Zod bersama | `packages/shared/src/` |
| Konfigurasi lingkungan | `src/config/` |
| Tes | Di samping kode (`*.spec.ts` unit, `*.int.spec.ts` integrasi), `test/` untuk e2e dan isolasi tenant |
| Dokumentasi modul | `src/modules/<nama>/README.md` |
| ADR | `docs/adr/NNNN-judul.md` |
| Runbook | `docs/runbooks/<topik>.md` |
| Kontrak untuk agen | `AGENTS.md` di root |
| Infrastruktur per proses (pool per role, Redis, antrean) | `src/infra/` |
| Runner worker dan scheduler | `src/worker/`, `src/scheduler/` |

---

## 3. Gambaran Arsitektur Backend

### 3.1 Proses

Satu aplikasi NestJS, satu image Docker, lima peran proses yang dipilih oleh `APP_ROLE`:

| Peran | Modul yang dimuat | Role basis data | Tugas |
|---|---|---|---|
| `api` | Semua modul bisnis (controller dan service), auth, realtime | `omniseller_api` (RLS aktif, tidak bisa membaca token) | Melayani REST dan Socket.IO |
| `webhook` | Hanya `webhook` dan `outbox` | `omniseller_api` | Verifikasi, simpan ke `webhook_inbox`, enqueue |
| `worker` | Modul bisnis (service saja), connectors, jobs | `omniseller_worker` (RLS aktif, bisa membaca token) | Menjalankan job BullMQ |
| `scheduler` | `scheduler`, `outbox-relay`, `partition-maintenance`, `retention` | `omniseller_system` untuk job lintas tenant (BYPASSRLS), `omniseller_worker` untuk job per tenant | Jadwal berulang, relay outbox, pemeliharaan |
| `research-collector` | `research` | `omniseller_worker` | Pengumpulan riset |

Setiap proses hanya menerima URL basis data untuk role yang boleh dipakainya (5.2): proses `api` dan `webhook` tidak pernah memegang koneksi `omniseller_worker` atau `omniseller_system`.

### 3.2 Lapisan dalam satu proses

```mermaid
flowchart TB
    C[Controller: HTTP, validasi Zod, auth guard, izin] --> S[Service: aturan bisnis, transaksi, event domain]
    S --> R[Repository: query Drizzle, tanpa aturan bisnis]
    S --> O[Outbox: tulis event di transaksi yang sama]
    R --> DB[(PostgreSQL, RLS)]
    O --> DB
    REL[Outbox relay di scheduler] --> DB
    REL --> Q[(BullMQ)]
    Q --> J[Job handler di worker]
    J --> S
    J --> X[Connector marketplace, email, AI]
```

Aturan lapisan:

- Controller tidak memanggil repository dan tidak berisi aturan bisnis.
- Service adalah satu-satunya tempat aturan bisnis dan satu-satunya yang membuka transaksi.
- Repository tidak membuka transaksi sendiri; menerima `tx` dari service.
- Job handler memanggil service, bukan repository, agar aturan bisnis tidak diduplikasi.
- Connector tidak tahu tentang basis data; menerima dan mengembalikan tipe ternormalisasi dari `packages/connectors/core`.

### 3.3 Aliran data tulis (contoh: terima pesanan)

1. `POST /v1/orders/:id/accept` masuk ke `OrderController.accept`.
2. Guard memverifikasi sesi dan izin `order:accept` (8.1); pipe memvalidasi parameter.
3. `OrderService.accept(ctx, id)` membuka `withTenantTx`, memuat pesanan dengan `FOR UPDATE`, memeriksa toko pesanan terhadap `ctx.storeScope`, memanggil `transition(order, 'ready_to_pack')`, menulis `order_event`, menulis `outbox_event{type:'order.accept_requested'}`, commit.
4. Relay outbox memindahkan event ke antrean `mp.outbound` dengan `jobId = order.accept|<order_id>`.
5. Job handler di worker memanggil `ConnectorRegistry.get(store).orders.accept(...)`, lalu `OrderService.markAccepted(...)` yang menulis `sync_job` dan event berikutnya.
6. Socket.IO mengirim `order.updated` ke room tenant dari event yang sama.

---

## 4. Struktur Proyek Backend

```
backend/
├── src/
│   ├── main.ts                     # bootstrap; memilih modul berdasarkan APP_ROLE
│   ├── app.module.ts
│   ├── config/
│   │   ├── env.schema.ts           # skema Zod semua variabel lingkungan, per peran
│   │   ├── config.module.ts
│   │   └── config.service.ts       # AppConfig bertipe, tidak ada process.env di luar sini
│   ├── db/
│   │   ├── client.ts               # pool Drizzle per role basis data (api, worker, system)
│   │   ├── tenant-tx.ts            # withTenantTx, withSystemTx, withStatusSource
│   │   ├── columns.ts              # ulid, baseColumns(), money() untuk cermin Drizzle
│   │   ├── migrate.ts              # migrator (12.1), dipanggil migrate.cli.ts
│   │   ├── bootstrap.ts            # role dan database lokal/uji, dipanggil bootstrap.cli.ts
│   │   └── schema/
│   │       ├── index.ts
│   │       ├── identity.ts
│   │       ├── channel.ts
│   │       ├── catalog.ts
│   │       ├── inventory.ts
│   │       ├── purchasing.ts
│   │       ├── orders.ts
│   │       ├── returns.ts
│   │       ├── sync.ts
│   │       ├── finance.ts
│   │       ├── chat.ts
│   │       ├── promo.ts
│   │       ├── health.ts
│   │       ├── crm.ts
│   │       ├── research.ts
│   │       ├── migration.ts
│   │       ├── campaign.ts
│   │       ├── notification.ts
│   │       ├── billing.ts
│   │       ├── platform.ts         # feature_flag, ai_*, file_object
│   │       └── audit.ts
│   ├── common/
│   │   ├── errors/                 # DomainError dan turunannya, ProblemDetailsFilter
│   │   ├── auth/                   # guards, decorators (@RequirePermission, @CurrentUser)
│   │   ├── validation/             # ZodValidationPipe
│   │   ├── pagination/             # cursor encode/decode
│   │   ├── money/
│   │   ├── time/
│   │   ├── ulid/
│   │   └── logging/
│   ├── modules/
│   │   ├── identity/               # tenant, user, role, invitation, api_key, device
│   │   ├── auth/                   # login, sesi, 2FA, refresh token
│   │   ├── channel/                # store, credential, channel_warehouse
│   │   ├── catalog/                # product, variant, listing, mapping, bundle
│   │   ├── inventory/              # warehouse, inventory, movement, count, transfer, allocation
│   │   ├── purchasing/
│   │   ├── orders/
│   │   ├── fulfillment/            # shipment, label, pick list, print job
│   │   ├── returns/
│   │   ├── sync/                   # sync_job, sync_cursor, stock pusher, polling
│   │   ├── finance/
│   │   ├── chat/
│   │   ├── promo/
│   │   ├── health/
│   │   ├── affiliate/
│   │   ├── crm/
│   │   ├── research/
│   │   ├── migration/
│   │   ├── campaign/
│   │   ├── notification/
│   │   ├── billing/
│   │   ├── reporting/
│   │   ├── ai/
│   │   ├── files/
│   │   ├── audit/
│   │   └── platform/               # feature flag, health check, admin internal
│   ├── jobs/
│   │   ├── registry.ts             # daftar semua job: antrean, handler, skema payload, opsi retry
│   │   ├── order-ingest/
│   │   ├── stock-push/
│   │   ├── mp-outbound/
│   │   ├── mp-poll/
│   │   ├── pdf/
│   │   ├── notify/
│   │   ├── ai/
│   │   ├── research/
│   │   └── settlement/
│   ├── scheduler/
│   │   ├── scheduler.runner.ts     # loop in-process: relay, stock flush, partisi
│   │   ├── outbox-relay.ts
│   │   ├── stock-flush.ts
│   │   └── retention.ts            # (menyusul)
│   ├── infra/                      # InfraModule: pool per role, Redis, antrean, outbox
│   ├── outbox/                     # Outbox.enqueue
│   ├── worker/                     # WorkerRunner: BullMQ Worker per antrean
│   ├── webhook/
│   │   └── webhook.controller.ts   # satu endpoint per marketplace (menyusul)
│   └── realtime/
│       └── realtime.gateway.ts     # (menyusul)
├── drizzle/
│   ├── migrations/                 # 0001_core.sql, 0002_...sql (berversi, sekali jalan)
│   └── sql/                        # 10_functions, 20_triggers, 30_policies, 40_grants, 90_seeds (repeatable)
├── test/
│   ├── setup/                      # global-setup (Testcontainers atau URL lokal), handles, factories
│   ├── db/                         # invarian basis data: RLS, stok, status, audit, FK, migrator
│   ├── jobs/                       # outbox, relay, debounce stok, lookup pra-tenant
│   ├── schema/                     # pnpm test:schema
│   ├── tenant-isolation/           # generator uji dari OpenAPI (menyusul bersama endpoint pertama)
│   └── e2e/
├── packages/
│   ├── shared/                     # @omniseller/shared: ULID, uang, izin, status
│   ├── logging/                    # @omniseller/logging: logger JSON dengan redaksi
│   └── connectors/                 # connector per marketplace (menyusul)
├── infra/docker/                   # compose.local.yml
├── tools/                          # dev.mjs (runner dev), scripts/native-infra.sh
├── .env.example
├── package.json                    # root workspace pnpm sekaligus paket aplikasi
├── pnpm-workspace.yaml             # anggota: packages/*
├── biome.json, tsconfig.base.json, tsconfig.json, tsconfig.build.json, vitest.config.ts
└── .gitignore
```

Bentuk satu modul (wajib sama untuk semua modul):

```
modules/orders/
├── README.md                # tanggung jawab, tabel yang dimiliki, event, endpoint, job
├── orders.module.ts
├── orders.controller.ts     # hanya di proses api
├── orders.service.ts        # aturan bisnis
├── orders.repository.ts     # query
├── orders.events.ts         # konstanta nama event dan skema payload
├── orders.errors.ts         # kelas error domain
├── dto/
│   ├── accept-order.dto.ts  # skema Zod request dan response
│   └── ...
├── orders.service.spec.ts   # unit
├── orders.int.spec.ts       # integrasi dengan Testcontainers
└── orders.controller.e2e.spec.ts
```

---

## 5. Lingkungan dan Konfigurasi

### 5.1 Empat lingkungan

| Lingkungan | Tujuan | Basis data | Marketplace | Rahasia | Cara jalan |
|---|---|---|---|---|---|
| `local` | Pengembangan di mesin engineer | PostgreSQL di Docker Compose atau terpasang langsung (`pnpm infra:native`) | Server tiruan (Hono) di Compose, opsional sandbox nyata | `.env.local` (tidak di-commit) | `pnpm dev` |
| `test` | Uji otomatis di mesin dan CI | Database baru per run, di Testcontainers atau server dari `TEST_PG_ADMIN_URL` | Server tiruan | Diatur `test/setup/global-setup.ts`, tanpa berkas env | `pnpm test`, `pnpm test:int` |
| `staging` | Verifikasi sebelum produksi, UAT | RDS staging | Sandbox nyata dan toko uji | AWS Secrets Manager | Deploy otomatis dari `main` |
| `production` | Layanan nyata | RDS produksi | Produksi | AWS Secrets Manager | Deploy dari tag dengan persetujuan |

Aturan:

- Tidak ada berkas `.env` di staging dan produksi. Semua nilai disuntik ECS dari Secrets Manager dan parameter tugas.
- `.env.example` selalu lengkap dan diperbarui pada PR yang menambah variabel. CI gagal bila `env.schema.ts` memiliki kunci yang tidak ada di `.env.example`.
- Nilai yang sama di semua lingkungan (misalnya nama antrean) bukan variabel lingkungan; ditulis sebagai konstanta.

### 5.2 Skema konfigurasi

Semua konfigurasi dibaca sekali saat proses mulai lewat `src/config/env.schema.ts` (Zod, `parseEnv`) dan disuntikkan sebagai token `ENV`. `process.env` hanya dibaca di `main.ts`. Proses gagal cepat dengan pesan jelas bila ada nilai yang kurang atau salah tipe.

Skema dibagi per peran, dan setiap peran hanya mendeklarasikan kunci yang dipakainya:

| Peran | Basis data | Kunci khusus |
|---|---|---|
| `api` | `DATABASE_URL` (`omniseller_api`) | `PORT` (bawaan 3000), `PUBLIC_WEB_URL` (satu-satunya origin CORS yang diizinkan, dengan cookie). Tidak pernah menerima kunci KMS token, rahasia marketplace, atau kredensial email |
| `webhook` | `DATABASE_URL` (`omniseller_api`) | `PORT` (bawaan 3001), rahasia verifikasi webhook per marketplace saat connector dibuat |
| `worker` | `DATABASE_URL_WORKER` (`omniseller_worker`) | `PUBLIC_WEB_URL` (tautan di email), `EMAIL_TRANSPORT` (`smtp`; `log` hanya boleh di `local`, `memory` hanya di `test`), `SMTP_URL` (wajib bila `smtp`: Mailpit lokal, SMTP Amazon SES di staging dan produksi), `EMAIL_FROM`. Rahasia marketplace, KMS, dan AI menyusul bersama modulnya |
| `scheduler` | `DATABASE_URL_WORKER` dan `DATABASE_URL_SYSTEM` (`omniseller_system`) | |
| `research-collector` | `DATABASE_URL_WORKER` | Kunci riset saat modulnya dibuat |

Kunci ditambahkan ke skema bersama kode yang memakainya, bukan lebih dulu; `.env.example` diperbarui pada PR yang sama (5.1).

### 5.3 Berkas lingkungan

| Berkas | Di-commit | Isi |
|---|---|---|
| `.env.example` | Ya | Semua kunci dengan nilai contoh atau kosong, dikelompokkan per peran, dengan komentar |
| `.env.local` | Tidak | Nilai lokal engineer, dimuat oleh `pnpm dev` dan `pnpm db:*` |
| `infra/docker/compose.local.yml` | Ya | Layanan lokal dengan Docker |
| `tools/scripts/native-infra.sh` | Ya | Layanan lokal tanpa Docker (PostgreSQL 15+ dan Redis terpasang), port sama dengan Compose |

### 5.4 Layanan lokal (Docker Compose)

| Layanan | Image | Port | Keterangan |
|---|---|---|---|
| `postgres` | `pgvector/pgvector:pg17` | 5433 | Superuser `postgres`; role dan database `omniseller` dibuat `pnpm db:bootstrap`. Port 5433 agar tidak bentrok dengan PostgreSQL lain di 5432 |
| `redis-queue` | `redis:7.2` | 6379 | AOF aktif |
| `redis-cache` | `redis:7.2` | 6380 | Tanpa persistensi |
| `meilisearch` | `getmeili/meilisearch` | 7700 | Menyusul bersama pencarian |
| `minio` | `minio/minio` | 9000, 9001 | Pengganti R2 dengan API S3; menyusul bersama berkas |
| `mailpit` | `axllent/mailpit` | 1025 (SMTP), 8025 (UI) | Menangkap semua email lokal (`SMTP_URL=smtp://127.0.0.1:1025`). Tanpa Docker, pakai `EMAIL_TRANSPORT=log`: isi email, termasuk tautan undangan, ditulis ke log worker |
| `mock-marketplace` | build lokal (Hono) | 4000 | Meniru Shopee, TikTok Shop, Lazada, Blibli, memutar ulang fixture webhook; menyusul bersama connector |

Layanan yang belum dipakai kode tidak dimasukkan ke Compose sampai kodenya ada.

### 5.5 Perbedaan perilaku per lingkungan

| Perilaku | local | test | staging | production |
|---|---|---|---|---|
| Migrasi otomatis saat mulai | Ya | Ya (basis data segar) | Tidak, tugas terpisah | Tidak, tugas terpisah |
| Seed data contoh | Ya (`pnpm db:seed`) | Fixture per tes | Data teranonimkan | Tidak |
| Connector nyata | Opsional lewat `MP_MODE=sandbox` | Tidak | Sandbox | Produksi |
| Kirim email dan WhatsApp | Mailpit, WhatsApp dimatikan | Dimatikan | Domain uji | Nyata |
| Panggilan AI | Dimatikan kecuali `AI_MODE=live` | Direkam (fixture) | Nyata dengan anggaran kecil | Nyata |
| Rate limit API | Longgar | Dimatikan | Sama dengan produksi | Produksi |
| Log | Pretty | Ringkas | JSON | JSON |

---

## 6. Identitas Rekaman: ULID

### 6.1 Keputusan

Semua kunci primer adalah **ULID**: 26 karakter Crockford base32 huruf besar, 48 bit waktu milidetik diikuti 80 bit acak, dibuat di aplikasi dengan generator monotonik.

| Aspek | Keputusan |
|---|---|
| Tipe kolom | Domain `ulid`: `CREATE DOMAIN ulid AS text COLLATE "C" CHECK (VALUE ~ '^[0-9A-HJKMNP-TV-Z]{26}$')`. Semua id dan kunci asing memakai domain ini, sehingga format diperiksa di satu tempat. `text`, bukan `char(26)`: panjang sudah dijamin regex, dan perbandingan dengan `current_setting()` (bertipe `text`) di predikat RLS tetap memakai indeks (terbukti oleh uji `tenant-isolation`) |
| Pembuatan | Di aplikasi lewat `newId()` dari `packages/shared/src/ulid.ts` (pustaka `ulid`, `monotonicFactory`). Tidak ada `DEFAULT` di basis data. Pengecualian yang dibuat di basis data dengan `gen_ulid()`: id seed tabel referensi global dan id baris `audit_log` (7.7) |
| Kolase | `"C"` wajib agar pengurutan byte sama dengan urutan waktu, sehingga `ORDER BY id` dan partisi range pada `id` benar |
| Di API | Dikirim apa adanya sebagai string 26 karakter. Skema Zod `ulidSchema` memvalidasi format di setiap batas |
| Di log | Boleh dicatat; ULID tidak mengandung data pribadi |

### 6.2 Alasan

- **Terurut waktu**: sisipan ke indeks B-tree selalu di ujung kanan, tanpa fragmentasi seperti UUID v4.
- **Dapat dibaca dan dibandingkan manusia**: mudah disalin dari log, disortir di spreadsheet, dan dibaca agen AI.
- **Memungkinkan partisi range pada `id`**: tabel besar dipartisi per bulan berdasarkan prefiks waktu ULID tanpa menambah kolom partisi ke kunci primer (bagian 7.6).
- **Tidak bocor informasi**: tidak mengungkap jumlah baris seperti serial.

### 6.3 Aturan pemakaian

- Kunci asing bertipe sama: domain `ulid`.
- Tidak ada kunci primer komposit. Tabel penghubung tetap memiliki `id` ULID ditambah batasan `UNIQUE` pada pasangan kolomnya.
- Jangan membuat ULID di SQL selain dua pengecualian di atas. Bila migrasi backfill membutuhkan id, tulis skrip TypeScript di `tools/scripts/`.
- `ulidSchema` (Zod) dipakai di semua DTO untuk parameter `:id`.

---

## 7. Desain Basis Data

### 7.1 Prinsip

1. **Basis data adalah penjaga terakhir.** Setiap aturan yang dapat dinyatakan sebagai batasan dinyatakan sebagai batasan: `NOT NULL`, `CHECK`, `UNIQUE`, kunci asing, trigger transisi.
2. **Tenant ada di setiap baris dan setiap kunci asing.** Baris anak tidak mungkin merujuk induk milik tenant lain (7.3).
3. **Tidak ada penghapusan diam-diam.** Setiap `ON DELETE` dipilih sadar (7.4). Data historis tidak pernah dihapus, hanya diarsipkan.
4. **Nilai turunan dihitung, bukan disimpan ganda**, kecuali bila dibutuhkan untuk indeks; saat itu memakai generated column `STORED`.
5. **Satu jalur untuk setiap perubahan berbahaya.** Stok lewat satu fungsi, status lewat trigger transisi, token lewat satu service.
6. **Skema terbaca tanpa dokumentasi tambahan.** Nama tabel tunggal (`order`, bukan `orders`), kolom `snake_case`, kunci asing `<tabel>_id`, waktu `<peristiwa>_at`, boolean `is_<sifat>`, jumlah `<apa>_count`, uang `<apa>_amount` atau nama jelas seperti `unit_price`.

### 7.2 Konvensi kolom standar

Setiap tabel milik tenant memiliki kolom berikut, ditulis di migrasi SQL dan dicerminkan di Drizzle lewat `baseColumns()`:

| Kolom | Tipe | Batasan |
|---|---|---|
| `id` | `ulid` | `PRIMARY KEY` (format diperiksa domain) |
| `tenant_id` | `ulid` | `NOT NULL`, `REFERENCES tenant(id) ON DELETE RESTRICT` |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()`, diperbarui trigger `touch_row` |
| `row_version` | `integer` | `NOT NULL DEFAULT 1`, dinaikkan trigger `touch_row`, dipakai optimistic locking |

Ditambah `UNIQUE (tenant_id, id)` pada setiap tabel yang menjadi induk kunci asing, agar 7.3 mungkin.

Kolom opsional yang dipakai bila relevan:

| Kolom | Tipe | Kapan |
|---|---|---|
| `deleted_at` | `timestamptz NULL` | Hanya tabel master yang boleh disembunyikan: `product`, `variant`, `warehouse`, `supplier`, `customer`, `chat_template`, `tag` |
| `created_by`, `updated_by` | `ulid NULL` | Tabel yang diubah pengguna langsung |
| `external_*` | `text` | Semua id dari marketplace disimpan sebagai `text`, tidak pernah `bigint`, karena format tiap marketplace berbeda |
| `*_snapshot` | `jsonb` | Salinan data pada saat kejadian (nama produk saat dipesan), tidak dijadikan sumber kebenaran |

Tabel global (tanpa `tenant_id`): `tenant`, `permission`, `plan`, `feature_flag`, `campaign` (baris sistem), `ai_route_config`, `research_source`, `order_status_transition` dan tabel transisi lain, `courier`.

### 7.3 Relasi lintas tenant yang mustahil

Setiap kunci asing ke tabel milik tenant adalah **komposit** dan menyertakan `tenant_id`:

```sql
-- pada tabel anak
tenant_id  ulid NOT NULL,
product_id ulid NOT NULL,
CONSTRAINT variant_product_fk
  FOREIGN KEY (tenant_id, product_id)
  REFERENCES product (tenant_id, id)
  ON DELETE RESTRICT
```

Akibatnya, bahkan bila kode aplikasi salah memasang `product_id`, basis data menolak baris yang merujuk produk tenant lain, termasuk untuk role `BYPASSRLS`. Batasan ditulis di migrasi SQL (ADR-027). Uji skema di CI (`pnpm test:schema`) membaca `pg_constraint` dan gagal bila ada kunci asing ke tabel milik tenant yang tidak diawali `tenant_id`.

Pengecualian yang dicatat: kunci asing ke tabel global (`tenant`, `permission`, `plan`, `research_source`) adalah kolom tunggal.

### 7.4 Kebijakan ON DELETE dan soft delete

| Jenis relasi | ON DELETE | Contoh |
|---|---|---|
| Komposisi: anak tidak bermakna tanpa induk | `CASCADE` | `order_item` ke `order`, `product_image` ke `product`, `purchase_order_line` ke `purchase_order`, `stock_count_line` ke `stock_count`, `role_permission` ke `role` |
| Referensi ke master yang mungkin masih dipakai | `RESTRICT` | `variant` ke `product`, `order_item` ke `variant`, `inventory` ke `warehouse`, `store` ke `tenant` |
| Referensi opsional ke konfigurasi | `SET NULL (x_id)` | `store.default_warehouse_id`, `order.warehouse_id`, `chat_thread.assigned_user_id`, `shipment.label_file_id` |
| Pemetaan yang menentukan ke mana stok didorong | `RESTRICT` | `channel_warehouse.warehouse_id`: gudang yang masih dipetakan harus dilepas pemetaannya lebih dulu (batasan `CHECK` memaksa `mapping_status` dan `warehouse_id` berubah bersama) |
| Ledger dan riwayat | `RESTRICT` dan tidak pernah dihapus | `stock_movement`, `order_event`, `audit_log`, `settlement_line`, `sync_job` |

**`SET NULL` pada FK komposit wajib menyebut kolomnya**: `ON DELETE SET NULL (warehouse_id)` (PostgreSQL 15+). Tanpa daftar kolom, PostgreSQL ikut meng-NULL-kan `tenant_id` yang `NOT NULL`, sehingga penghapusan induk gagal. Contoh nyata: job `files.cleanup_expired` menghapus `file_object` label yang kedaluwarsa, dan `shipment.label_file_id` harus menjadi NULL tanpa menyentuh `tenant_id`. Uji skema memeriksa daftar kolom setiap FK `SET NULL`.

Soft delete (`deleted_at`) hanya pada tabel master di 7.2. Aturan:

- Baris dengan `deleted_at` tidak muncul di daftar dan tidak boleh dipilih di formulir baru, tetapi tetap dapat dirujuk oleh data historis.
- Batasan unik pada tabel master memakai indeks parsial `WHERE deleted_at IS NULL` sehingga SKU yang dihapus dapat dipakai ulang.
- Hard delete tabel master hanya lewat job penghapusan tenant (16.6) dengan role `omniseller_system`, dalam urutan dependensi yang dihasilkan dari `information_schema`.

### 7.5 Row-Level Security

- Setiap tabel milik tenant: `ENABLE ROW LEVEL SECURITY` dan `FORCE ROW LEVEL SECURITY`, kebijakan `tenant_isolation` untuk `SELECT`, `INSERT`, `UPDATE`, `DELETE` dengan predikat `tenant_id = current_setting('app.tenant_id', true)`.
- Empat role basis data:

| Role | RLS | Hak | Dipakai oleh |
|---|---|---|---|
| `omniseller_api` | Ditegakkan | CRUD tabel tenant, dengan pengecualian di bawah. Pada `store_credential` hanya SELECT kolom metadata (kedaluwarsa, jumlah gagal), tanpa kolom token dan tanpa INSERT atau UPDATE | `api`, `webhook` |
| `omniseller_worker` | Ditegakkan | CRUD tabel tenant termasuk membaca dan menulis token, dengan pengecualian di bawah | `worker`, `research-collector`, job per tenant di `scheduler` |
| `omniseller_system` | `BYPASSRLS` | Hanya untuk job lintas tenant yang terdaftar: outbox relay, pemeliharaan partisi, retensi, penghapusan tenant, statistik platform | `scheduler` |
| `omniseller_migrator` | `BYPASSRLS` | Pemilik skema: DDL, fungsi, grant | Tugas migrasi |

Pengecualian hak yang berlaku untuk `omniseller_api` dan `omniseller_worker` (`drizzle/sql/40_grants.sql`):

| Tabel | Hak | Alasan |
|---|---|---|
| Tabel referensi global (`plan`, `permission`, `feature_flag`, `*_status_transition`) | SELECT saja | Diubah oleh seed dan migrasi |
| `inventory` | SELECT, dan UPDATE hanya kolom `bin_location` dan `min_stock` | Jumlah stok hanya lewat `apply_stock_movement()` (I2) |
| `stock_movement`, `audit_log` | SELECT saja | Ditulis fungsi `SECURITY DEFINER` dan trigger; tidak dapat dipalsukan dari aplikasi |
| `order_event`, `order_external_ref` | SELECT dan INSERT | Hanya tambah |
| `outbox_event` | INSERT saja | Relay (`omniseller_system`) yang membaca, menandai, dan menghapus |
| `webhook_inbox` | api: INSERT dan SELECT kolom `id`, `source`, `event_id`; worker: SELECT dan UPDATE | Tabel global tanpa RLS; proses webhook tidak perlu membaca payload tenant mana pun |
| Partisi (`order_p202609` dan seterusnya) | Tidak ada | Hanya terjangkau lewat tabel induk, tempat kebijakan RLS berlaku |

- `withTenantTx(handle, ctx, fn)` memanggil `set_config('app.tenant_id', $1, true)` (setara `SET LOCAL`, aman untuk parameter terikat), juga `app.actor_type`, `app.actor_id`, dan `app.request_id` untuk trigger audit, dalam satu pernyataan.
- `withSystemTx(handle, fn)` menolak dipanggil bila pool bukan milik role `omniseller_system`, dan hanya proses `scheduler` yang menerima URL role itu.
- Setelah transaksi selesai, `current_setting('app.tenant_id', true)` pada sesi yang sama bernilai string kosong, bukan NULL. Predikat `tenant_id = current_setting(...)` tetap mengembalikan nol baris untuk keduanya (diuji).

**Pembacaan sebelum tenant diketahui.** Beberapa alur harus menemukan tenant dari data yang tidak membawa tenant: webhook (`channel` dan id toko marketplace), login (email), refresh token, token perangkat, API key, dan tautan undangan. Di bawah RLS query biasa mengembalikan nol baris, sehingga alur ini memakai fungsi `SECURITY DEFINER` yang sempit, masing-masing mengembalikan `tenant_id` untuk dilanjutkan di dalam `withTenantTx`:

| Fungsi | Dipakai oleh | Boleh dieksekusi |
|---|---|---|
| `resolve_store(channel, external_shop_id)` | Proses webhook dan job `order.ingest` | api, worker |
| `auth_login_candidates(email)` | Login; email yang sama boleh ada di beberapa tenant, pengguna memilih | api |
| `auth_resolve_invitation(hash)`, `auth_resolve_password_reset(hash)` | Pratinjau dan penerimaan undangan, konfirmasi atur ulang sandi. Mengembalikan status token (`expires_at`, `accepted_at` atau `used_at`, `revoked_at`) agar service menolak dengan error yang tepat | api |
| `auth_resolve_refresh_token(hash)`, `auth_resolve_device(hash)`, `auth_resolve_api_key(hash)` | Guard token mobile, perangkat, dan API key; menyusul bersama klien itu | api |

Fungsi `SECURITY DEFINER` selalu menetapkan `search_path`, dicabut dari `PUBLIC`, dan hanya diberikan ke role yang disebut di atas. Di kode, fungsi ini hanya dipanggil lewat kelas `PreTenantLookup` (`modules/identity/identity.repository.ts`) dan `resolve_store` di modul `channel`; tidak ada jalur lain yang membaca data tenant sebelum `app.tenant_id` ditetapkan.

### 7.6 Partisi pada ULID

Tabel bervolume tinggi dipartisi **range pada kolom `id`**. Karena 10 karakter pertama ULID adalah waktu, batas partisi bulanan adalah ULID dari milidetik pertama bulan itu diikuti 16 karakter `0`.

| Tabel | Interval | Batas partisi dibuat di depan | Retensi |
|---|---|---|---|
| `order`, `order_item`, `order_event` | Bulanan | 3 bulan | 24 bulan aktif, lalu arsip |
| `stock_movement` | Bulanan | 3 bulan | 24 bulan |
| `sync_job` | Bulanan | 3 bulan | 3 bulan |
| `audit_log` | Bulanan | 3 bulan | 12 bulan aktif, ekspor ke R2 |
| `ai_call_log` | Bulanan | 3 bulan | 12 bulan |
| `research.research_snapshot` | Bulanan | 3 bulan | 90 hari mentah, ringkasan 24 bulan |

`webhook_inbox` dan `outbox_event` sengaja tidak dipartisi: batasan unik `(source, event_id)` dan indeks parsial relay harus berfungsi lintas waktu, sedangkan PostgreSQL menuntut kunci partisi ada di setiap batasan unik. Retensinya ditangani hapus batch harian (9.5).

Aturan:

- Kunci primer tabel terpartisi tetap `(id)`. Batasan unik lain harus menyertakan `id`; untuk `order` batasan unik bisnis `(tenant_id, store_id, external_order_id)` ditegakkan lewat tabel pembantu `order_external_ref` yang tidak dipartisi (7.8.6), karena PostgreSQL menuntut kunci partisi ada di setiap batasan unik.
- Kunci asing dari tabel lain ke tabel terpartisi merujuk `(tenant_id, id)`, yang valid karena `id` adalah kunci partisi.
- Daftar tabel terpartisi dan retensinya ada di fungsi SQL `partition_targets()`. Fungsi `maintain_partitions(now)` (`SECURITY DEFINER`, karena membuat partisi butuh hak pemilik tabel) membuat partisi bulan berjalan dan tiga bulan ke depan dengan nama `<tabel>_pYYYYMM`. Dijalankan setiap `db:migrate` dan setiap 6 jam oleh scheduler; idempoten. Uji skema memastikan setiap tabel terpartisi terdaftar di `partition_targets()`.
- Pelepasan (`DETACH`) partisi yang melewati retensi dan ekspor ke R2 menyusul bersama job arsip; partisi pertama baru kedaluwarsa tiga bulan setelah rilis (`sync_job`).
- Partisi `DEFAULT` selalu ada agar sisipan tidak pernah gagal; alarm bila partisi default berisi baris.
- `id` dibuat saat baris disisipkan, bukan saat pesanan terjadi. Impor 90 hari pesanan saat onboarding masuk ke partisi bulan impor. Query daftar berdasarkan `ordered_at` tidak dapat memangkas partisi; untuk layar yang hanya melihat pesanan aktif, tambahkan batas bawah `id >= ulid_lower_bound(...)`.

### 7.7 Trigger dan fungsi standar

| Nama | Jenis | Tabel | Tugas |
|---|---|---|---|
| `touch_row()` | `BEFORE UPDATE` | Semua tabel yang punya `updated_at` dan `row_version` | Mengisi `updated_at = now()` dan `row_version = OLD.row_version + 1` |
| `enforce_status_transition('<tabel>')` | `BEFORE UPDATE OF status` | `order`, `shipment`, `sync_job`; nanti `return_request`, `purchase_order`, `stock_count`, `stock_transfer`, `migration_job` | Menolak transisi yang tidak ada di `<tabel>_status_transition`; mengisi `status_changed_at`. Nama tabel diberikan sebagai argumen trigger, karena pada tabel terpartisi `TG_TABLE_NAME` berisi nama partisi (`order_p202609`), bukan `order` |
| `inventory_guard()` | `BEFORE INSERT OR UPDATE OR DELETE` | `inventory` | Menolak perubahan kolom jumlah (`on_hand`, `reserved`, `buffer`, `damaged`) dan penghapusan bila `app.stock_write` bukan `'on'`; kolom lain (`bin_location`, `min_stock`) boleh diubah |
| `ensure_inventory(...)`, `apply_stock_movement(...)` | Fungsi `SECURITY DEFINER` | `inventory`, `stock_movement` | Satu-satunya jalur mengubah stok. Memeriksa bahwa tenant parameter sama dengan `app.tenant_id` (`TENANT_MISMATCH` bila tidak), mengunci baris, menolak hasil di bawah nol, dan mencatat saldo sesudahnya termasuk `buffer` (cadangan kampanye) |
| `audit_row()` | `AFTER INSERT OR UPDATE OR DELETE`, `SECURITY DEFINER` | `variant` (harga, HPP, status), `channel_listing` (harga, status, pemetaan), `store` (status, mode sinkron, gudang default, nama), `role`, `role_permission`, `user_role`, `user_store_scope`, `user_warehouse_scope`, `channel_warehouse`, `stock_allocation_rule`; nanti `fee_schedule` | Menulis `audit_log` dengan `before`, `after`, `app.actor_type`, `app.actor_id`, `app.request_id`. Id baris dibuat `gen_ulid()` di basis data karena satu pernyataan dapat menyentuh banyak baris. Tabel yang sering disinkronkan memakai `WHEN` agar hanya perubahan kolom penting yang diaudit |
| `audit_log_immutable()` | `BEFORE UPDATE OR DELETE` | `audit_log` | Menolak semua perubahan |
| `outbox_notify()` | `AFTER INSERT FOR EACH STATEMENT` | `outbox_event` | `pg_notify('outbox', '')` agar relay bangun tanpa menunggu interval |
| `resolve_store`, `auth_*` | Fungsi `SECURITY DEFINER` | | Pembacaan sebelum tenant diketahui (7.5) |
| `gen_ulid()`, `ulid_lower_bound(ts)` | Fungsi | | Id seed dan audit; batas partisi |
| `partition_targets()`, `maintain_partitions(now)` | Fungsi | | Partisi (7.6) |

Fungsi, trigger, kebijakan, grant, dan seed ada di `drizzle/sql/` sebagai file repeatable yang dijalankan ulang setiap `db:migrate` (12.1). Fungsi memakai `CREATE OR REPLACE`. Trigger dan kebijakan dibuat hanya bila belum ada (`ensure_trigger`), karena membuat ulang trigger mengunci tabel; mengubah definisi trigger atau kebijakan yang sudah ada dilakukan di migrasi berversi.

### 7.8 Skema per domain

Notasi: setiap tabel memiliki kolom standar (7.2) kecuali ditandai **global** (tanpa `tenant_id`) atau **tanpa base**. Kunci asing ditulis `→ tabel` dan selalu komposit `(tenant_id, x_id)` bila tabel tujuan milik tenant; `SET NULL` berarti `SET NULL (x_id)` (7.4). Definisi yang berlaku ada di `drizzle/migrations/`; tabel di bawah yang belum ada di migrasi dibuat bersama modulnya. Nilai `CHECK` untuk kolom status merujuk mesin status di 7.9.

#### 7.8.1 Identitas dan akses

```mermaid
erDiagram
    tenant ||--o{ user : memiliki
    tenant ||--o{ role : memiliki
    role ||--o{ role_permission : berisi
    permission ||--o{ role_permission : dipakai
    user ||--o{ user_role : punya
    role ||--o{ user_role : diberikan
    user ||--o{ user_store_scope : dibatasi
    user ||--o{ user_warehouse_scope : dibatasi
    user ||--o{ refresh_token : sesi
    tenant ||--o{ invitation : mengundang
    tenant ||--o{ api_key : menerbitkan
    tenant ||--o{ device : mendaftarkan
```

**tenant** (global)

| Kolom | Tipe | Batasan |
|---|---|---|
| `id` | `ulid` | PK ULID |
| `name` | `text` | NOT NULL |
| `slug` | `text` | NOT NULL, UNIQUE, `CHECK (slug ~ '^[a-z0-9-]{3,40}$')` |
| `timezone` | `text` | NOT NULL DEFAULT `'Asia/Jakarta'` |
| `status` | `text` | NOT NULL, CHECK IN (`active`, `suspended`, `closing`, `closed`) |
| `plan_id` | `ulid` | NOT NULL → `plan(id)` RESTRICT |
| `legal` | `jsonb` | NOT NULL DEFAULT `{}`; bentuk: `{nib, npwp, pkp: bool, documents: []}` |
| `settings` | `jsonb` | NOT NULL DEFAULT `{}` |
| `created_at`, `updated_at`, `row_version` | | Standar |

**user**

| Kolom | Tipe | Batasan |
|---|---|---|
| `email` | `citext` | NOT NULL; UNIQUE `(tenant_id, email)` |
| `password_hash` | `text` | NOT NULL |
| `name` | `text` | NOT NULL |
| `status` | `text` | NOT NULL, CHECK IN (`invited`, `active`, `disabled`) |
| `totp_secret_enc` | `bytea` | NULL; terenkripsi DEK tenant |
| `totp_enabled` | `boolean` | NOT NULL DEFAULT false |
| `locale` | `text` | NOT NULL DEFAULT `'id'` |
| `last_login_at` | `timestamptz` | NULL |
| `failed_login_count` | `integer` | NOT NULL DEFAULT 0 |
| `locked_until` | `timestamptz` | NULL |

**role**: `name text NOT NULL`, `is_system boolean NOT NULL DEFAULT false`, `description text`; UNIQUE `(tenant_id, name)`. Peran bawaan (Owner, Admin, Gudang, CS, Finance, Viewer) disalin ke setiap tenant saat tenant dibuat, sehingga `tenant_id` selalu terisi dan RLS seragam.

**permission** (global): `id`, `code text NOT NULL UNIQUE` (bentuk `modul:aksi`, contoh `order:accept`), `module text NOT NULL`, `description text`. Diisi seed dan diperbarui migrasi.

**role_permission**: `role_id → role` CASCADE, `permission_id → permission(id)` RESTRICT; UNIQUE `(role_id, permission_id)`.

**user_role**: `user_id → user` CASCADE, `role_id → role` RESTRICT; UNIQUE `(user_id, role_id)`.

**user_store_scope**: `user_id → user` CASCADE, `store_id → store` CASCADE; UNIQUE `(user_id, store_id)`. Tidak ada baris berarti semua toko.

**user_warehouse_scope**: `user_id → user` CASCADE, `warehouse_id → warehouse` CASCADE; UNIQUE `(user_id, warehouse_id)`.

**invitation**: `email citext NOT NULL`, `role_id → role` RESTRICT, `invited_by → user` SET NULL, `token_hash text UNIQUE`, `expires_at timestamptz NOT NULL`, `sent_at timestamptz`, `revoked_at timestamptz`, `accepted_at timestamptz`, `accepted_user_id → user` SET NULL. Indeks unik parsial `(tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL`: satu undangan terbuka per email. `token_hash` NULL sampai job pengiriman membuat token; token mentah tidak pernah masuk basis data atau outbox, dan setiap kirim ulang membuat token baru sehingga tautan lama langsung tidak berlaku.

**password_reset_token**: `user_id → user` CASCADE, `token_hash text UNIQUE`, `expires_at timestamptz NOT NULL` (60 menit), `used_at timestamptz`. Dibuat oleh job `auth.password_reset_email`, bukan oleh request. Pemakaian menandai semua token pengguna itu terpakai dan mencabut semua sesinya.

**refresh_token** (untuk aplikasi mobile dan ekstensi; sesi web tidak memakai tabel ini, lihat 8.10): `user_id → user` CASCADE, `device_id → device` SET NULL, `token_hash text NOT NULL UNIQUE`, `expires_at NOT NULL`, `revoked_at`, `rotated_from_id → refresh_token` SET NULL, `user_agent text`, `ip inet`.

**api_key**: `name text NOT NULL`, `prefix text NOT NULL` (8 karakter pertama untuk identifikasi), `key_hash text NOT NULL UNIQUE`, `scopes text[] NOT NULL DEFAULT '{}'`, `last_used_at`, `revoked_at`, `created_by → user` SET NULL.

**device**: `kind text NOT NULL CHECK IN ('print_agent','mobile')`, `name text NOT NULL`, `token_hash text NOT NULL UNIQUE`, `warehouse_id → warehouse` SET NULL, `app_version text`, `last_seen_at`, `revoked_at`.

#### 7.8.2 Kanal dan toko

**store**

| Kolom | Tipe | Batasan |
|---|---|---|
| `channel` | `text` | NOT NULL, CHECK IN (`shopee`, `tiktokshop`, `lazada`, `blibli`, `shopify`, `woocommerce`, `manual`) |
| `external_shop_id` | `text` | NOT NULL; UNIQUE `(channel, external_shop_id)` **global lintas tenant**, satu toko tidak bisa terhubung ke dua tenant |
| `name` | `text` | NOT NULL |
| `region` | `text` | NOT NULL DEFAULT `'ID'` |
| `status` | `text` | NOT NULL, CHECK IN (`connecting`, `active`, `token_expiring`, `reauth_required`, `disconnected`) |
| `sync_mode` | `text` | NOT NULL DEFAULT `'read_only'`, CHECK IN (`read_only`, `live`); `read_only` adalah mode paralel migrasi, push stok dan proses pesanan dimatikan |
| `default_warehouse_id` | `ulid` | → `warehouse` SET NULL |
| `connected_at`, `disconnected_at`, `last_order_sync_at`, `last_product_sync_at` | `timestamptz` | NULL |
| `settings` | `jsonb` | NOT NULL DEFAULT `{}`; bentuk terdokumentasi di `modules/channel/README.md` |

**store_credential**

| Kolom | Tipe | Batasan |
|---|---|---|
| `store_id` | `ulid` | NOT NULL, UNIQUE, → `store` CASCADE |
| `access_token_enc` | `bytea` | NOT NULL; AES-256-GCM dengan DEK tenant, format gabungan `version(1)` + `nonce(12)` + `ciphertext` + `tag(16)` |
| `refresh_token_enc` | `bytea` | NULL |
| `dek_version` | `integer` | NOT NULL |
| `access_expires_at`, `refresh_expires_at` | `timestamptz` | NULL |
| `scopes` | `text[]` | NOT NULL DEFAULT `'{}'` |
| `last_refreshed_at` | `timestamptz` | NULL |
| `refresh_fail_count` | `integer` | NOT NULL DEFAULT 0 |

Grant: `omniseller_api` mendapat `INSERT` dan `UPDATE` pada tabel ini tetapi `SELECT` hanya pada kolom non-token (`id`, `tenant_id`, `store_id`, `dek_version`, `access_expires_at`, `refresh_expires_at`, `scopes`, `last_refreshed_at`, `refresh_fail_count`). `omniseller_worker` mendapat `SELECT` penuh.

**channel_warehouse**

| Kolom | Tipe | Batasan |
|---|---|---|
| `store_id` | `ulid` | NOT NULL → `store` CASCADE |
| `external_warehouse_id` | `text` | NOT NULL; UNIQUE `(store_id, external_warehouse_id)` |
| `name` | `text` | NOT NULL |
| `address` | `jsonb` | NULL |
| `kind` | `text` | NOT NULL, CHECK IN (`seller`, `fulfillment`) |
| `warehouse_id` | `ulid` | → `warehouse` RESTRICT (7.4) |
| `mapping_status` | `text` | NOT NULL DEFAULT `'unmapped'`, CHECK IN (`unmapped`, `mapped`, `marketplace_managed`) |
| `is_default` | `boolean` | NOT NULL DEFAULT false |
| `active` | `boolean` | NOT NULL DEFAULT true |
| `last_seen_at` | `timestamptz` | NOT NULL |
| Batasan tabel | | `CHECK ((kind = 'fulfillment' AND warehouse_id IS NULL AND mapping_status = 'marketplace_managed') OR (kind = 'seller' AND (mapping_status = 'unmapped') = (warehouse_id IS NULL)))` |

#### 7.8.3 Katalog

```mermaid
erDiagram
    product ||--o{ variant : memiliki
    product ||--o{ product_image : memiliki
    variant ||--o{ bundle_component : "sebagai bundle"
    variant ||--o{ bundle_component : "sebagai komponen"
    variant ||--o{ channel_listing : dipetakan
    store ||--o{ channel_listing : memuat
    channel_listing ||--o{ listing_stock_state : "per gudang marketplace"
    channel_warehouse ||--o{ listing_stock_state : untuk
```

**product**: `name text NOT NULL`, `sku text NOT NULL`, `description text`, `brand text`, `category_path text`, `status text NOT NULL CHECK IN ('active','archived')`, `attribute_names text[] NOT NULL DEFAULT '{}'` (nama atribut varian, misalnya `{Warna,Ukuran}`), `deleted_at`. UNIQUE parsial `(tenant_id, sku) WHERE deleted_at IS NULL`.

**variant**

| Kolom | Tipe | Batasan |
|---|---|---|
| `product_id` | `ulid` | NOT NULL → `product` RESTRICT |
| `sku` | `text` | NOT NULL; UNIQUE parsial `(tenant_id, sku) WHERE deleted_at IS NULL` |
| `barcode` | `text` | NULL; UNIQUE parsial `(tenant_id, barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL` |
| `name` | `text` | NOT NULL (contoh `Hitam, L`) |
| `attributes` | `jsonb` | NOT NULL DEFAULT `{}`; kunci harus subset `product.attribute_names` (diuji di service) |
| `cost_price` | `bigint` | NOT NULL DEFAULT 0, CHECK `>= 0`; HPP rata-rata tertimbang |
| `base_price` | `bigint` | NOT NULL, CHECK `>= 0` |
| `weight_g` | `integer` | NOT NULL, CHECK `> 0` |
| `length_mm`, `width_mm`, `height_mm` | `integer` | NULL, CHECK `> 0` |
| `is_bundle` | `boolean` | NOT NULL DEFAULT false |
| `status` | `text` | NOT NULL CHECK IN (`active`, `archived`) |
| `deleted_at` | `timestamptz` | NULL |

**product_image**: `product_id → product` CASCADE, `variant_id → variant` CASCADE (NULL berarti gambar produk), `file_object_id → file_object` RESTRICT, `position smallint NOT NULL`; UNIQUE `(product_id, variant_id, position) NULLS NOT DISTINCT`.

**bundle_component**: `bundle_variant_id → variant` CASCADE, `component_variant_id → variant` RESTRICT, `qty integer NOT NULL CHECK (qty > 0)`; UNIQUE `(bundle_variant_id, component_variant_id)`; CHECK `bundle_variant_id <> component_variant_id`. Service memastikan `bundle_variant.is_bundle = true` dan komponen bukan bundle (tidak ada bundle bersarang).

**channel_listing**

| Kolom | Tipe | Batasan |
|---|---|---|
| `store_id` | `ulid` | NOT NULL → `store` CASCADE |
| `external_item_id` | `text` | NOT NULL |
| `external_variant_id` | `text` | NOT NULL DEFAULT `''` (listing tanpa varian memakai string kosong agar UNIQUE berlaku) |
| `external_sku` | `text` | NULL |
| `variant_id` | `ulid` | → `variant` RESTRICT; NULL berarti belum terpetakan |
| `title` | `text` | NOT NULL |
| `price`, `original_price` | `bigint` | NULL, CHECK `>= 0` |
| `status` | `text` | NOT NULL CHECK IN (`active`, `inactive`, `banned`, `deleted`, `unknown`) |
| `stock_at_channel` | `bigint` | NULL; nilai terakhir yang dibaca dari marketplace |
| `link_fields` | `jsonb` | NOT NULL DEFAULT `{"title":false,"description":false,"price":true,"images":false,"weight":true}` |
| `overrides` | `jsonb` | NOT NULL DEFAULT `{}` |
| `channel_data` | `jsonb` | NOT NULL DEFAULT `{}`; data ternormalisasi terakhir dari connector |
| `last_pulled_at` | `timestamptz` | NULL |
| Batasan tabel | | UNIQUE `(store_id, external_item_id, external_variant_id)`; INDEX `(tenant_id, variant_id)`; INDEX `(tenant_id, store_id, status)` |

**listing_stock_state**: `listing_id → channel_listing` CASCADE, `channel_warehouse_id → channel_warehouse` CASCADE, `last_pushed_qty bigint`, `last_pushed_at timestamptz`, `last_error text`, `push_fail_count integer NOT NULL DEFAULT 0`; UNIQUE `(listing_id, channel_warehouse_id)`. Dipakai stock pusher untuk melewati push yang nilainya tidak berubah dan untuk diagnostik.

#### 7.8.4 Gudang dan stok

```mermaid
erDiagram
    warehouse ||--o{ inventory : menyimpan
    variant ||--o{ inventory : "stok per gudang"
    inventory ||--o{ stock_movement : "mutasi (via fungsi)"
    warehouse ||--o{ stock_count : opname
    stock_count ||--o{ stock_count_line : baris
    warehouse ||--o{ stock_transfer : "asal/tujuan"
    stock_transfer ||--o{ stock_transfer_line : baris
    store ||--o{ stock_allocation_rule : alokasi
    variant ||--o{ campaign_stock_hold : cadangan
```

**warehouse**: `code text NOT NULL`, `name text NOT NULL`, `address jsonb NOT NULL`, `is_default boolean NOT NULL DEFAULT false`, `active boolean NOT NULL DEFAULT true`, `deleted_at`; UNIQUE `(tenant_id, code)`; UNIQUE parsial `(tenant_id) WHERE is_default AND deleted_at IS NULL` (tepat satu gudang default).

**inventory** (dijaga trigger `inventory_guard`)

| Kolom | Tipe | Batasan |
|---|---|---|
| `variant_id` | `ulid` | NOT NULL → `variant` RESTRICT |
| `warehouse_id` | `ulid` | NOT NULL → `warehouse` RESTRICT |
| `on_hand` | `bigint` | NOT NULL DEFAULT 0, CHECK `>= 0` |
| `reserved` | `bigint` | NOT NULL DEFAULT 0, CHECK `>= 0` |
| `buffer` | `bigint` | NOT NULL DEFAULT 0, CHECK `>= 0` |
| `damaged` | `bigint` | NOT NULL DEFAULT 0, CHECK `>= 0` |
| `available` | `bigint` | `GENERATED ALWAYS AS (on_hand - reserved - buffer) STORED`; boleh negatif sebagai sinyal overselling, push ke marketplace memakai `GREATEST(available, 0)` |
| `bin_location` | `text` | NULL |
| `min_stock` | `bigint` | NULL, CHECK `>= 0` |
| Batasan tabel | | UNIQUE `(tenant_id, variant_id, warehouse_id)` |

**stock_movement** (partisi bulanan pada `id`)

| Kolom | Tipe | Batasan |
|---|---|---|
| `variant_id`, `warehouse_id` | `ulid` | NOT NULL, komposit → `variant`, `warehouse` RESTRICT |
| `type` | `text` | NOT NULL, CHECK IN (`order_reserve`, `order_release`, `order_ship`, `return_restock`, `return_quarantine`, `adjustment`, `count_apply`, `transfer_out`, `transfer_in`, `purchase_receipt`, `quarantine_in`, `quarantine_out`, `campaign_hold`, `campaign_release`, `migration_initial`) |
| `on_hand_delta`, `reserved_delta`, `damaged_delta`, `buffer_delta` | `bigint` | NOT NULL DEFAULT 0; CHECK setidaknya satu tidak nol |
| `on_hand_after`, `reserved_after`, `damaged_after`, `buffer_after` | `bigint` | NOT NULL; nilai setelah mutasi, diisi fungsi. `buffer` ikut dicatat karena cadangan kampanye (`campaign_hold`, `campaign_release`) diwujudkan sebagai buffer |
| `reference_type` | `text` | NULL, CHECK IN (`order_item`, `return_item`, `stock_count_line`, `stock_transfer_line`, `goods_receipt_line`, `campaign_stock_hold`, `migration_job`, `manual`) |
| `reference_id` | `ulid` | NULL; tanpa FK karena polimorfik, tetapi dipasangkan dengan `reference_type` dan diuji di integrasi |
| `reason` | `text` | NULL; wajib untuk `adjustment` (ditegakkan fungsi) |
| `note` | `text` | NULL |
| `actor_user_id` | `ulid` | NULL |
| Indeks | | `(tenant_id, variant_id, warehouse_id, id DESC)`; `(tenant_id, reference_type, reference_id)` |

Tabel ini hanya ditulis oleh `apply_stock_movement()`. Role aplikasi hanya punya SELECT; `omniseller_system` punya DELETE untuk arsip dan penghapusan tenant.

**stock_allocation_rule**: `store_id → store` CASCADE, `channel_warehouse_id → channel_warehouse` CASCADE (NULL berarti semua), `variant_id → variant` CASCADE (NULL berarti semua), `mode text NOT NULL CHECK IN ('all','percent','fixed')`, `value bigint NOT NULL CHECK (value >= 0)`, `buffer bigint NOT NULL DEFAULT 0`, `priority integer NOT NULL DEFAULT 100`, `active boolean NOT NULL DEFAULT true`; UNIQUE `(store_id, channel_warehouse_id, variant_id) NULLS NOT DISTINCT`. Aturan paling spesifik menang; kesetaraan ditentukan `priority` terkecil.

**stock_count**: `warehouse_id → warehouse` RESTRICT, `mode text CHECK IN ('full','partial')`, `status text` (7.9), `status_changed_at`, `started_by → user` SET NULL, `applied_at`, `applied_by → user` SET NULL, `note text`.

**stock_count_line**: `stock_count_id → stock_count` CASCADE, `variant_id → variant` RESTRICT, `expected_qty bigint NOT NULL`, `counted_qty bigint` NULL sampai dihitung, `diff bigint GENERATED ALWAYS AS (counted_qty - expected_qty) STORED`, `movement_id → stock_movement` SET NULL; UNIQUE `(stock_count_id, variant_id)`.

**stock_transfer**: `from_warehouse_id`, `to_warehouse_id` → `warehouse` RESTRICT, CHECK `from_warehouse_id <> to_warehouse_id`, `status`, `status_changed_at`, `sent_at`, `received_at`, `note`.

**stock_transfer_line**: `stock_transfer_id → stock_transfer` CASCADE, `variant_id → variant` RESTRICT, `qty bigint CHECK (qty > 0)`, `received_qty bigint NOT NULL DEFAULT 0 CHECK (received_qty BETWEEN 0 AND qty)`, `out_movement_id`, `in_movement_id → stock_movement` SET NULL; UNIQUE `(stock_transfer_id, variant_id)`.

**campaign_stock_hold**: `variant_id`, `warehouse_id` RESTRICT, `campaign_id → campaign(id)` RESTRICT (NULL untuk cadangan manual), `qty bigint CHECK (qty > 0)`, `starts_at`, `ends_at` NOT NULL, CHECK `ends_at > starts_at`, `status text CHECK IN ('scheduled','active','released','cancelled')`, `hold_movement_id`, `release_movement_id → stock_movement` SET NULL. Cadangan diwujudkan sebagai `buffer` di `inventory` melalui `campaign_hold` dan `campaign_release`.

#### 7.8.5 Pembelian

| Tabel | Kolom penting | Batasan dan relasi |
|---|---|---|
| `supplier` | `name`, `contact jsonb`, `payment_terms_days integer`, `notes`, `deleted_at` | UNIQUE parsial `(tenant_id, name) WHERE deleted_at IS NULL` |
| `purchase_order` | `number text`, `supplier_id`, `warehouse_id`, `status`, `status_changed_at`, `expected_at`, `subtotal bigint`, `payment_status CHECK IN ('unpaid','partial','paid')`, `notes` | `supplier_id → supplier` RESTRICT; `warehouse_id → warehouse` RESTRICT; UNIQUE `(tenant_id, number)`; nomor dibuat `PO-YYYYMM-NNNN` dari sequence per tenant di tabel `document_sequence` |
| `purchase_order_line` | `purchase_order_id`, `variant_id`, `qty_ordered`, `qty_received`, `unit_cost bigint` | → `purchase_order` CASCADE; → `variant` RESTRICT; CHECK `qty_ordered > 0`, `qty_received BETWEEN 0 AND qty_ordered`, `unit_cost >= 0`; UNIQUE `(purchase_order_id, variant_id)` |
| `goods_receipt` | `purchase_order_id`, `received_at`, `received_by`, `note` | → `purchase_order` RESTRICT |
| `goods_receipt_line` | `goods_receipt_id`, `purchase_order_line_id`, `qty`, `unit_cost`, `movement_id` | → `goods_receipt` CASCADE; → `purchase_order_line` RESTRICT; CHECK `qty > 0`; `movement_id → stock_movement` SET NULL; penerimaan memperbarui `variant.cost_price` rata-rata tertimbang di service |
| `document_sequence` | `kind text`, `period text`, `next_value bigint` | UNIQUE `(tenant_id, kind, period)`; diambil dengan `SELECT ... FOR UPDATE` |

#### 7.8.6 Pesanan dan pengiriman

```mermaid
erDiagram
    store ||--o{ order : menerima
    order ||--|| order_external_ref : "unik per toko"
    order ||--o{ order_item : berisi
    order ||--o{ order_event : riwayat
    order ||--o{ order_problem : masalah
    order ||--o{ order_tag : ditandai
    tag ||--o{ order_tag : dipakai
    order ||--o{ shipment : dikirim
    shipment ||--o{ shipment_package : paket
    pick_wave ||--o{ order : mengelompokkan
    device ||--o{ print_job : mencetak
    customer ||--o{ order : memesan
```

**order** (partisi bulanan pada `id`)

| Kolom | Tipe | Batasan |
|---|---|---|
| `store_id` | `ulid` | NOT NULL → `store` RESTRICT |
| `channel` | `text` | NOT NULL; disalin dari `store.channel` untuk filter tanpa join |
| `external_order_id` | `text` | NOT NULL; keunikan ditegakkan `order_external_ref` |
| `external_status` | `text` | NULL |
| `status` | `text` | NOT NULL; nilai di 7.9; dijaga trigger |
| `status_changed_at` | `timestamptz` | NOT NULL |
| `fulfillment_mode` | `text` | NOT NULL CHECK IN (`seller`, `marketplace`) |
| `channel_warehouse_id` | `ulid` | → `channel_warehouse` SET NULL |
| `warehouse_id` | `ulid` | → `warehouse` SET NULL; wajib terisi sebelum `ready_to_pack` (ditegakkan service) |
| `pick_wave_id` | `ulid` | → `pick_wave` SET NULL |
| `customer_id` | `ulid` | → `customer` SET NULL |
| `is_cod`, `is_dropship` | `boolean` | NOT NULL DEFAULT false |
| `dropship_sender` | `jsonb` | NULL; `{name, phone}` |
| `buyer_username`, `buyer_name`, `buyer_phone` | `text` | NULL; data pribadi, dianonimkan oleh job retensi |
| `shipping_address` | `jsonb` | NULL; data pribadi |
| `shipping_provider`, `shipping_service` | `text` | NULL |
| `shipping_service_type` | `text` | NULL CHECK IN (`regular`, `next_day`, `same_day`, `instant`) |
| `tracking_number` | `text` | NULL |
| `ship_by_at` | `timestamptz` | NULL; batas marketplace |
| `internal_ship_by_at` | `timestamptz` | NULL; batas internal dari cut-off kurir (PRD FR-CMP-05) |
| `ordered_at` | `timestamptz` | NOT NULL |
| `paid_at`, `shipped_at`, `delivered_at`, `completed_at`, `cancelled_at` | `timestamptz` | NULL |
| `cancel_reason` | `text` | NULL |
| `cancelled_by` | `text` | NULL CHECK IN (`buyer`, `seller`, `marketplace`, `system`) |
| `subtotal`, `discount_total`, `shipping_fee_buyer`, `voucher_seller`, `total` | `bigint` | NOT NULL DEFAULT 0, CHECK `>= 0`; `total` NOT NULL tanpa default |
| `currency` | `char(3)` | NOT NULL DEFAULT `'IDR'` |
| `buyer_note`, `internal_note` | `text` | NULL |
| `source` | `text` | NOT NULL CHECK IN (`webhook`, `poll`, `manual`, `link`, `distribution`, `migration`) |
| `risk_score` | `smallint` | NULL, CHECK `BETWEEN 0 AND 100` |
| `problem_count` | `integer` | NOT NULL DEFAULT 0; dipelihara service |
| `raw_payload_ref` | `text` | NULL; id `sync_job` atau `webhook_inbox` sebagai teks, tanpa FK karena retensinya lebih pendek |
| Indeks | | `(tenant_id, status, ship_by_at)`; `(tenant_id, store_id, ordered_at DESC)`; `(tenant_id, tracking_number)`; `(tenant_id, warehouse_id, status)`; `(tenant_id, customer_id)` |

**order_external_ref** (tidak dipartisi, tanpa `updated_at` dan `row_version`): `store_id → store` RESTRICT, `external_order_id text NOT NULL`, `order_id → order` CASCADE; UNIQUE `(store_id, external_order_id)` dan UNIQUE `(order_id)`. Ditulis dalam transaksi yang sama dengan `INSERT order`. Inilah yang membuat webhook duplikat tidak pernah menghasilkan pesanan ganda.

**order_item** (partisi bulanan pada `id`)

| Kolom | Tipe | Batasan |
|---|---|---|
| `order_id` | `ulid` | NOT NULL → `order` CASCADE |
| `external_item_id` | `text` | NOT NULL; keunikan `(order_id, external_item_id)` dijamin service dengan kunci baris `order` (`FOR UPDATE`) saat upsert, ditambah INDEX `(order_id, external_item_id)` |
| `listing_id` | `ulid` | → `channel_listing` SET NULL |
| `variant_id` | `ulid` | → `variant` RESTRICT; NULL berarti SKU belum terpetakan dan pesanan bermasalah |
| `sku_snapshot`, `title_snapshot` | `text` | NOT NULL |
| `variant_snapshot` | `jsonb` | NOT NULL DEFAULT `{}` |
| `qty` | `integer` | NOT NULL CHECK `> 0` |
| `unit_price`, `discount`, `line_total` | `bigint` | NOT NULL DEFAULT 0 CHECK `>= 0` |
| `warehouse_id` | `ulid` | → `warehouse` SET NULL |
| `reserved_qty` | `integer` | NOT NULL DEFAULT 0, CHECK `reserved_qty BETWEEN 0 AND qty` |
| `shipped_qty` | `integer` | NOT NULL DEFAULT 0, CHECK `shipped_qty BETWEEN 0 AND qty` |
| `returned_qty` | `integer` | NOT NULL DEFAULT 0, CHECK `returned_qty BETWEEN 0 AND shipped_qty` |
| Indeks | | `(tenant_id, variant_id, id DESC)` |

**order_event** (partisi bulanan pada `id`, tanpa `updated_at` dan `row_version`): `order_id → order` CASCADE, `type text NOT NULL` (contoh `status_changed`, `problem_added`, `note_added`, `label_printed`, `packed`, `handed_over`), `from_status`, `to_status`, `actor_type text NOT NULL CHECK IN ('user','system','marketplace','device')`, `actor_id ulid`, `payload jsonb NOT NULL DEFAULT '{}'`; INDEX `(order_id, id)`.

**order_problem**: `order_id → order` CASCADE, `code text NOT NULL CHECK IN ('unmapped_sku','insufficient_stock','unmapped_warehouse','address_incomplete','duplicate','watchlist','high_value','fulfillment_conflict')`, `detail jsonb`, `resolved_at`, `resolved_by → user` SET NULL, `resolution text`; UNIQUE parsial `(order_id, code) WHERE resolved_at IS NULL`.

**tag**: `name text NOT NULL`, `color text`, `deleted_at`; UNIQUE parsial `(tenant_id, name) WHERE deleted_at IS NULL`. **order_tag**: `order_id → order` CASCADE, `tag_id → tag` RESTRICT; UNIQUE `(order_id, tag_id)`.

**pick_wave**: `warehouse_id → warehouse` RESTRICT, `status text CHECK IN ('open','picking','done','cancelled')`, `created_by → user` SET NULL, `order_count integer NOT NULL DEFAULT 0`, `note`.

**shipment**

| Kolom | Tipe | Batasan |
|---|---|---|
| `order_id` | `ulid` | NOT NULL → `order` RESTRICT; satu pesanan boleh punya beberapa pengiriman bila dipecah |
| `status` | `text` | NOT NULL; nilai di 7.9 |
| `status_changed_at` | `timestamptz` | NOT NULL |
| `provider`, `service` | `text` | NULL |
| `external_shipment_id` | `text` | NULL |
| `tracking_number` | `text` | NULL; INDEX `(tenant_id, tracking_number)` |
| `label_file_id` | `ulid` | → `file_object` SET NULL |
| `pickup_type` | `text` | NULL CHECK IN (`pickup`, `dropoff`) |
| `pickup_at`, `packed_at`, `handed_over_at`, `delivered_at`, `failed_at`, `rto_at`, `rto_received_at` | `timestamptz` | NULL |
| `packed_by`, `handed_over_by` | `ulid` | → `user` SET NULL |
| `failed_reason` | `text` | NULL |
| `insured` | `boolean` | NOT NULL DEFAULT false |
| `insured_value`, `shipping_cost_actual` | `bigint` | NULL CHECK `>= 0` |
| `weight_g` | `integer` | NULL CHECK `> 0` |
| `dims` | `jsonb` | NULL |
| `package_count` | `integer` | NOT NULL DEFAULT 1 CHECK `> 0` |

**shipment_package**: `shipment_id → shipment` CASCADE, `external_package_id text`, `tracking_number text`, `items jsonb NOT NULL` (daftar `{order_item_id, qty}`), `label_file_id → file_object` SET NULL; UNIQUE parsial `(shipment_id, external_package_id) WHERE external_package_id IS NOT NULL`.

**print_job**: `device_id → device` RESTRICT, `kind text CHECK IN ('label','pick_list','packing_list','invoice','barcode','manifest')`, `file_object_id → file_object` RESTRICT, `printer_name text`, `copies smallint NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 10)`, `status text CHECK IN ('queued','sent','printed','failed','cancelled')`, `attempts integer NOT NULL DEFAULT 0`, `error text`, `requested_by → user` SET NULL, `printed_at`; INDEX `(device_id, status, id)`.

#### 7.8.7 Retur

**return_request**: `order_id → order` RESTRICT, `store_id → store` RESTRICT, `external_return_id text`, `kind text NOT NULL CHECK IN ('return_refund','refund_only','rto','cancellation')`, `status text` (7.9), `status_changed_at`, `reason_code text`, `buyer_reason text`, `evidence jsonb`, `respond_by_at timestamptz`, `refund_amount bigint CHECK (>= 0)`, `decided_at`, `decided_by → user` SET NULL, `decision_note text`; UNIQUE parsial `(store_id, external_return_id) WHERE external_return_id IS NOT NULL`.

**return_item**: `return_request_id → return_request` CASCADE, `order_item_id → order_item` RESTRICT, `qty integer CHECK (qty > 0)`, `condition text CHECK IN ('sellable','damaged','missing')` NULL sampai diterima, `received_at`, `received_by → user` SET NULL, `restock_movement_id`, `quarantine_movement_id → stock_movement` SET NULL; UNIQUE `(return_request_id, order_item_id)`. Service memastikan jumlah `qty` per `order_item` tidak melebihi `shipped_qty`.

#### 7.8.8 Sinkronisasi, outbox, dan webhook

**webhook_inbox** (global, tidak dipartisi, retensi 30 hari dengan hapus batch)

| Kolom | Tipe | Batasan |
|---|---|---|
| `id` | `ulid` | PK |
| `source` | `text` | NOT NULL CHECK IN nilai `store.channel` selain `manual`, ditambah `xendit` (webhook penagihan) |
| `event_id` | `text` | NOT NULL; UNIQUE `(source, event_id)`, inilah idempotensi webhook |
| `event_type` | `text` | NULL |
| `external_shop_id` | `text` | NULL |
| `tenant_id`, `store_id` | `ulid` | NULL; diisi setelah dipetakan, tanpa FK agar baris tetap tersimpan walau toko belum dikenal |
| `received_at` | `timestamptz` | NOT NULL DEFAULT now() |
| `signature_valid` | `boolean` | NOT NULL |
| `headers` | `jsonb` | NOT NULL; tanpa header otorisasi |
| `payload` | `jsonb` | NOT NULL |
| `processed_at` | `timestamptz` | NULL |
| `attempts` | `integer` | NOT NULL DEFAULT 0 |
| `last_error` | `text` | NULL |
| Indeks | | Parsial `(id) WHERE processed_at IS NULL`; `(received_at)` untuk retensi |

Kebijakan RLS pada tabel ini: `omniseller_api` boleh `INSERT` dan `SELECT`; `omniseller_worker` boleh `UPDATE` kolom pemrosesan. Tidak ada predikat tenant.

**sync_job** (partisi bulanan pada `id`): `store_id → store` RESTRICT (NULL untuk job tanpa toko), `kind text NOT NULL` (contoh `orders.list`, `stock.update`, `label.get`), `direction text CHECK IN ('pull','push')`, `status text` (7.9), `status_changed_at`, `attempts integer`, `request_summary jsonb`, `response_summary jsonb` (keduanya sudah disamarkan), `error_code text`, `error_message text`, `started_at`, `finished_at`, `duration_ms integer`, `queue_job_id text`, `trace_id text`; INDEX `(tenant_id, store_id, kind, id DESC)`.

**sync_cursor**: `store_id → store` CASCADE, `resource text NOT NULL`, `cursor text NOT NULL`, `advanced_at timestamptz NOT NULL`; UNIQUE `(store_id, resource)`.

**outbox_event** (tanpa `updated_at` dan `row_version`)

| Kolom | Tipe | Batasan |
|---|---|---|
| `aggregate_type` | `text` | NOT NULL (contoh `order`, `inventory`, `listing`) |
| `aggregate_id` | `ulid` | NOT NULL |
| `event_type` | `text` | NOT NULL (contoh `order.accept_requested`, `inventory.changed`) |
| `payload` | `jsonb` | NOT NULL; divalidasi skema Zod event sebelum ditulis |
| `queue` | `text` | NOT NULL; nama antrean BullMQ tujuan |
| `job_name` | `text` | NOT NULL; nama job di antrean itu |
| `job_id` | `text` | NOT NULL; kunci idempoten BullMQ (9.2) |
| `job_options` | `jsonb` | NOT NULL DEFAULT `{}` (delay, priority) |
| `published_at` | `timestamptz` | NULL |
| `attempts` | `integer` | NOT NULL DEFAULT 0 |
| `last_error` | `text` | NULL |
| Indeks | | Parsial `(id) WHERE published_at IS NULL`; retensi 7 hari setelah `published_at` |

Satu event menghasilkan satu baris per job konsumen (`Outbox.enqueue`), masing-masing dengan `job_id` sendiri. Relay (scheduler) mengambil batch 500 dengan `FOR UPDATE SKIP LOCKED`, menambahkan ke BullMQ, lalu menandai `published_at`. Relay mendengarkan `NOTIFY outbox` lewat koneksi langsung ke PostgreSQL, bukan lewat RDS Proxy (sesi `LISTEN` tidak cocok dengan pooling transaksi). Konsumen tetap idempoten karena pengiriman minimal sekali.

#### 7.8.9 Keuangan

| Tabel | Kolom penting | Batasan dan relasi |
|---|---|---|
| `fee_schedule` | `channel`, `category_key text`, `admin_pct numeric(6,4)`, `service_pct`, `program_pct`, `fixed_fee bigint`, `effective_from date`, `effective_to date` | UNIQUE `(tenant_id, channel, category_key, effective_from)`; persentase memakai `numeric` karena bukan uang; CHECK `effective_to IS NULL OR effective_to > effective_from` |
| `settlement` | `store_id`, `external_batch_id text`, `period_start`, `period_end`, `total_amount bigint`, `source CHECK IN ('api','file')`, `file_object_id`, `imported_at`, `imported_by` | → `store` RESTRICT; UNIQUE parsial `(store_id, external_batch_id) WHERE external_batch_id IS NOT NULL` |
| `settlement_line` | `settlement_id`, `order_id`, `external_order_id text`, `expected_amount bigint`, `paid_amount bigint`, `fees jsonb`, `tax_withheld bigint`, `status CHECK IN ('pending','matched','mismatch','unmatched')`, `diff bigint GENERATED (paid_amount - expected_amount) STORED`, `reviewed_at`, `reviewed_by`, `note` | → `settlement` CASCADE; `order_id → order` SET NULL; INDEX `(tenant_id, status)` |
| `order_cost` | `order_id`, `cogs`, `packing_cost`, `shipping_cost_seller`, `marketplace_fees`, `affiliate_commission`, `rto_cost`, `claim_compensation` (nilai negatif mengurangi biaya), `tax_withheld`, `net_profit`, `computed_at`, `basis CHECK IN ('estimated','settled')` | `order_id → order` CASCADE, UNIQUE `(order_id)`; semua `bigint`; `net_profit` dihitung service dari kolom lain dan diverifikasi uji |
| `tax_document` | `store_id`, `kind CHECK IN ('omzet_statement','skb','withholding_proof','other')`, `period text`, `file_object_id`, `status CHECK IN ('missing','uploaded','expired')`, `valid_until date` | → `store` CASCADE; UNIQUE `(store_id, kind, period)` |
| `expense` | `category text`, `amount bigint`, `incurred_on date`, `allocation CHECK IN ('none','per_order','per_item')`, `note`, `created_by` | CHECK `amount > 0` |
| `receivable` | `customer_id`, `credit_limit bigint`, `terms_days integer`, `balance bigint` (dipelihara service, diverifikasi uji), `deposit bigint` | `customer_id → customer` RESTRICT, UNIQUE `(customer_id)` |
| `receivable_entry` | `receivable_id`, `type CHECK IN ('order','payment','refund','adjustment','deposit')`, `amount bigint`, `reference_type`, `reference_id`, `due_at`, `note` | → `receivable` CASCADE; INDEX `(receivable_id, id)` |

#### 7.8.10 Chat, promosi, kesehatan toko, affiliate, dan pelanggan

| Tabel | Kolom penting | Batasan dan relasi |
|---|---|---|
| `chat_thread` | `store_id`, `external_thread_id text`, `buyer_username text`, `status CHECK IN ('open','assigned','resolved')`, `assigned_user_id`, `last_message_at`, `unread_count integer` | → `store` CASCADE; UNIQUE `(store_id, external_thread_id)`; `assigned_user_id → user` SET NULL |
| `chat_message` | `thread_id`, `external_message_id text`, `direction CHECK IN ('in','out')`, `kind CHECK IN ('text','image','product','order','sticker','other')`, `body text`, `attachments jsonb`, `sent_at`, `sent_by`, `ai_generated boolean`, `ai_call_log_id` | → `chat_thread` CASCADE; UNIQUE parsial `(thread_id, external_message_id) WHERE external_message_id IS NOT NULL`; INDEX `(thread_id, id)` |
| `chat_template` | `name`, `body`, `variables text[]`, `category`, `deleted_at` | UNIQUE parsial `(tenant_id, name) WHERE deleted_at IS NULL` |
| `promotion` | `store_id`, `external_promo_id text`, `kind CHECK IN ('discount','voucher','flash_sale','bundle','addon','free_shipping','other')`, `name`, `starts_at`, `ends_at`, `status CHECK IN ('draft','scheduled','active','ended','cancelled','failed')`, `auto_renew boolean`, `renew_count integer`, `max_renew integer`, `params jsonb` | → `store` CASCADE; UNIQUE parsial `(store_id, external_promo_id) WHERE external_promo_id IS NOT NULL`; CHECK `ends_at > starts_at` |
| `promotion_item` | `promotion_id`, `listing_id`, `promo_price bigint`, `stock_limit bigint`, `margin_check jsonb` | → `promotion` CASCADE; `listing_id → channel_listing` CASCADE; UNIQUE `(promotion_id, listing_id)` |
| `boost_schedule` | `store_id`, `active boolean`, `batch_size smallint`, `interval_minutes integer` | → `store` CASCADE; UNIQUE `(store_id)` |
| `boost_schedule_item` | `boost_schedule_id`, `listing_id`, `position integer`, `last_boosted_at` | → `boost_schedule` CASCADE; → `channel_listing` CASCADE; UNIQUE `(boost_schedule_id, listing_id)` |
| `shop_health_snapshot` | `store_id`, `captured_at`, `late_shipment_rate numeric(6,4)`, `non_fulfillment_rate`, `cancel_rate`, `return_rate`, `chat_response_rate`, `penalty_points integer`, `source CHECK IN ('api','computed')`, `raw jsonb` | → `store` CASCADE; UNIQUE `(store_id, captured_at, source)` |
| `affiliate_order` | `order_id`, `creator_external_id text`, `creator_name text`, `commission_amount bigint`, `content_type text`, `source_data jsonb` | → `order` CASCADE; UNIQUE `(order_id)` |
| `customer` | `channel`, `external_buyer_id text`, `display_name text`, `phone_masked text`, `total_orders integer`, `total_spent bigint`, `first_order_at`, `last_order_at`, `watchlist boolean`, `watchlist_reason text`, `watchlist_until timestamptz`, `deleted_at` | UNIQUE `(tenant_id, channel, external_buyer_id)`; CHECK `watchlist = false OR watchlist_until IS NOT NULL` (retensi daftar pantau wajib berbatas waktu) |

#### 7.8.11 Riset (skema `research`)

Semua tabel di skema `research`. `research_source` global. Tidak ada kunci asing ke `order`, `order_item`, `customer`, atau kolom pembeli mana pun (invarian I8). Satu-satunya hubungan ke data operasional adalah `tracked_competitor.variant_id`.

| Tabel | Kolom penting | Batasan dan relasi |
|---|---|---|
| `research_source` (global) | `code text UNIQUE`, `kind CHECK IN ('marketplace','supplier')`, `domain text`, `parser_version text`, `status CHECK IN ('healthy','degraded','paused')`, `last_check_at`, `robots_cached jsonb` | |
| `research_item` | `source_id`, `url text`, `external_id text`, `title`, `shop_name`, `shop_location`, `category_path`, `thumbnail_url`, `first_seen_at`, `last_captured_at` | `source_id → research_source(id)` RESTRICT; UNIQUE `(tenant_id, source_id, url)` |
| `research_snapshot` (partisi bulanan, tanpa `updated_at` dan `row_version`, tidak pernah diubah) | `research_item_id`, `captured_at`, `price bigint`, `price_before bigint`, `sold_count bigint`, `rating numeric(3,2)`, `review_count integer`, `stock_status CHECK IN ('in_stock','out_of_stock','unknown')`, `position_keyword text`, `position_rank integer`, `method CHECK IN ('extension','link','collector')`, `parser_version text` | → `research_item` CASCADE; INDEX `(research_item_id, id DESC)` |
| `research_daily` | `research_item_id`, `day date`, `price_min`, `price_median`, `price_max`, `sold_delta bigint`, `snapshot_count integer` | UNIQUE `(research_item_id, day)` |
| `tracked_competitor` | `research_item_id`, `variant_id`, `channel`, `active boolean`, `alert_rules jsonb` | → `research_item` CASCADE; `variant_id → public.variant` RESTRICT (satu-satunya FK ke skema operasional); UNIQUE `(research_item_id, variant_id)` |
| `research_alert` | `tracked_competitor_id`, `kind CHECK IN ('price_below','out_of_stock','promo_started','we_are_highest')`, `payload jsonb`, `read_at` | → `tracked_competitor` CASCADE |
| `keyword_insight` | `keyword text`, `source_id`, `period_start date`, `estimated_sales bigint`, `estimated_revenue bigint`, `avg_price bigint`, `seller_count integer`, `competition_score numeric(5,2)`, `method text` | UNIQUE `(tenant_id, source_id, keyword, period_start)` |
| `review_insight` | `research_item_id`, `period_start date`, `star_distribution jsonb`, `complaint_themes jsonb`, `praise_themes jsonb`, `sample_size integer` | → `research_item` CASCADE; UNIQUE `(research_item_id, period_start)` |
| `research_consent` | `user_id`, `text_version text`, `accepted_at` | `user_id → public.user` RESTRICT; UNIQUE `(tenant_id, user_id, text_version)` |

#### 7.8.12 Migrasi, kampanye, notifikasi, billing, platform, berkas, dan audit

| Tabel | Kolom penting | Batasan dan relasi |
|---|---|---|
| `migration_job` | `source_app CHECK IN ('bigseller','ginee','jubelio','spreadsheet','other')`, `kind CHECK IN ('products','costs','mappings','stock')`, `status` (7.9), `status_changed_at`, `file_object_id`, `column_mapping jsonb`, `stats jsonb`, `started_at`, `finished_at`, `created_by` | `file_object_id → file_object` RESTRICT |
| `migration_row_error` | `migration_job_id`, `row_number integer`, `field text`, `message text`, `raw jsonb` | → `migration_job` CASCADE; INDEX `(migration_job_id, row_number)` |
| `campaign` (global untuk baris sistem, atau milik tenant) | `tenant_id` NULL untuk sistem, `name`, `kind CHECK IN ('double_date','harbolnas','payday','ramadan','lebaran','holiday','custom','marketplace')`, `channel text` NULL, `starts_at`, `ends_at`, `is_system boolean` | CHECK `ends_at > starts_at`; CHECK `(is_system AND tenant_id IS NULL) OR (NOT is_system AND tenant_id IS NOT NULL)`; kebijakan RLS: baris sistem terbaca semua tenant |
| `campaign_plan` | `campaign_id`, `forecast jsonb`, `buffer_plan jsonb`, `staffing jsonb`, `status CHECK IN ('draft','ready','running','evaluated')`, `evaluation jsonb` | `campaign_id → campaign(id)` RESTRICT; UNIQUE `(tenant_id, campaign_id)` |
| `courier_cutoff` | `warehouse_id`, `courier_code text`, `cutoff_time time`, `days_of_week smallint[]`, `active boolean` | → `warehouse` CASCADE; UNIQUE `(warehouse_id, courier_code)`; CHECK setiap elemen `days_of_week BETWEEN 0 AND 6` (fungsi) |
| `operating_hours` | `name`, `schedule jsonb`, `valid_from date`, `valid_to date`, `is_default boolean` | UNIQUE parsial `(tenant_id) WHERE is_default` |
| `notification` | `user_id` NULL untuk semua pengguna, `kind text`, `severity CHECK IN ('info','warning','critical')`, `title`, `body`, `data jsonb`, `channels_sent jsonb`, `read_at` | `user_id → user` CASCADE; INDEX `(tenant_id, user_id, read_at, id DESC)` |
| `notification_preference` | `user_id`, `kind text`, `in_app boolean`, `email boolean`, `whatsapp boolean` | → `user` CASCADE; UNIQUE `(user_id, kind)` |
| `plan` (global) | `code text UNIQUE`, `name`, `limits jsonb` (toko, gudang, pesanan per bulan, pengguna, tautan riset, token AI), `features text[]`, `price_monthly bigint`, `active boolean` | |
| `subscription` | `plan_id`, `status CHECK IN ('trialing','active','past_due','cancelled','expired')`, `current_period_start`, `current_period_end`, `xendit_customer_id text`, `xendit_plan_id text`, `cancel_at` | `plan_id → plan(id)` RESTRICT; UNIQUE parsial `(tenant_id) WHERE status IN ('trialing','active','past_due')` |
| `invoice` | `subscription_id`, `xendit_invoice_id text`, `amount bigint`, `status CHECK IN ('pending','paid','expired','void')`, `due_at`, `paid_at`, `pdf_file_id` | → `subscription` RESTRICT; UNIQUE parsial `(xendit_invoice_id) WHERE xendit_invoice_id IS NOT NULL` |
| `usage_counter` | `metric text`, `period text` (`YYYY-MM`), `value bigint` | UNIQUE `(tenant_id, metric, period)`; dinaikkan dengan `UPDATE ... SET value = value + $1` atomik |
| `feature_flag` (global) | `key text UNIQUE`, `description`, `enabled_default boolean`, `rollout_pct smallint CHECK (BETWEEN 0 AND 100)` | |
| `feature_flag_override` | `flag_id`, `enabled boolean` | `flag_id → feature_flag(id)` CASCADE; UNIQUE `(tenant_id, flag_id)` |
| `ai_route_config` (global) | `route text UNIQUE`, `model text`, `effort text`, `prompt_version text`, `max_tokens integer`, `enabled boolean` | |
| `ai_call_log` (partisi bulanan, tanpa `updated_at` dan `row_version`) | `route`, `model`, `prompt_version`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cost_micro_usd bigint`, `stop_reason text`, `latency_ms integer`, `reference_type`, `reference_id` | INDEX `(tenant_id, route, id DESC)` |
| `ai_budget` | `period text`, `token_limit bigint`, `tokens_used bigint` | UNIQUE `(tenant_id, period)` |
| `file_object` | `tenant_id` NULL untuk berkas sistem, `bucket text`, `object_key text`, `mime text`, `size_bytes bigint`, `sha256 text`, `purpose CHECK IN ('product_image','label','pick_list','export','import','settlement','tax_document','evidence','other')`, `expires_at`, `created_by` | UNIQUE `(bucket, object_key)`; CHECK `size_bytes > 0` |
| `audit_log` (partisi bulanan, hanya tambah, tanpa `updated_at` dan `row_version`) | `actor_type CHECK IN ('user','system','api_key','device')`, `actor_id text`, `request_id text`, `action text`, `entity_type text`, `entity_id ulid`, `before jsonb`, `after jsonb`, `ip inet` | INDEX `(tenant_id, entity_type, entity_id, id DESC)`; trigger `audit_log_immutable`; id dari `gen_ulid()` (7.7); hanya ditulis trigger `audit_row` |

### 7.9 Mesin status

Setiap tabel berstatus memiliki tabel transisi `<tabel>_status_transition (from_status, to_status)` yang diisi seed dan dijaga trigger `enforce_status_transition`. Perubahan ke status yang sama diabaikan trigger. Mengubah daftar transisi adalah migrasi data yang ditinjau.

**order**

| Dari | Ke yang diizinkan | Efek stok (dilakukan service dalam transaksi yang sama) |
|---|---|---|
| `unpaid` | `new`, `cancelled` | Tidak ada |
| `new` | `problem`, `ready_to_pack`, `cancelled`, `marketplace_fulfilled` | Masuk `new`: `order_reserve` per item dengan `variant_id` dan `warehouse_id` terisi |
| `problem` | `new`, `ready_to_pack`, `cancelled` | Masuk `new` kembali: reservasi item yang belum direservasi |
| `ready_to_pack` | `packed`, `problem`, `cancelled` | Tidak ada |
| `packed` | `ready_to_ship`, `ready_to_pack`, `cancelled` | Tidak ada |
| `ready_to_ship` | `shipped`, `cancelled` | Masuk `shipped`: `order_ship` (`on_hand -qty`, `reserved -qty`), `shipped_qty` diisi |
| `shipped` | `delivered`, `return_in_progress`, `cancelled` | Tidak ada |
| `delivered` | `completed`, `return_in_progress` | Tidak ada |
| `completed` | `return_in_progress` | Tidak ada |
| `return_in_progress` | `returned`, `completed` | Masuk `returned`: `return_restock` atau `return_quarantine` per `return_item` sesuai kondisi |
| `marketplace_fulfilled` | `completed`, `cancelled`, `return_in_progress` | Tidak ada; stok dikelola marketplace |
| `cancelled` | Tidak ada | Masuk `cancelled` dari status dengan reservasi: `order_release` untuk `reserved_qty` yang tersisa |

`order.status` awal ditentukan dari status marketplace lewat tabel pemetaan connector. Pesanan dengan `fulfillment_mode = 'marketplace'` masuk sebagai `marketplace_fulfilled` dan tidak pernah menyentuh stok.

**Transisi yang dilaporkan marketplace.** Tabel transisi punya kolom `via`: `any` untuk langkah di sisi penjual, `marketplace` untuk fakta yang dilaporkan marketplace dan boleh melompati langkah penjual. Baris `marketplace` hanya berlaku bila transaksi berada di dalam `withStatusSource(tx, 'marketplace', ...)`. Ini diperlukan karena status internal tidak selalu berjalan lewat langkah kemas dan serah terima: di mode paralel migrasi (`store.sync_mode = 'read_only'`) semua pesanan diproses di aplikasi lama, dan pedagang solo boleh mencetak label tanpa scan (DOKUMEN-UI-UX 15.2). Tanpa lompatan ini, kabar "sudah dikirim" dari marketplace ditolak trigger dan `order_ship` tidak pernah terjadi, sehingga stok tertahan sebagai reservasi.

| Dari | Boleh ke (via `marketplace`) |
|---|---|
| `new`, `problem`, `ready_to_pack`, `packed` | `shipped`, `delivered`, `completed` |
| `ready_to_ship` | `delivered`, `completed` |
| `shipped` | `completed` |

Aturan pemetaan status marketplace ke status internal:

- Status yang menggambarkan kemajuan di sisi penjual (Shopee `PROCESSED`, TikTok Shop `AWAITING_COLLECTION`) hanya memperbarui `external_status`, tidak mengubah `status` internal.
- Fakta (dikirim atau dalam perjalanan, diterima, selesai, dibatalkan, retur) mengubah `status` internal, bila perlu dengan lompatan `marketplace`.
- Efek stok lompatan ke `shipped` sama dengan jalur biasa: `order_ship` untuk `reserved_qty` setiap item. Item yang belum pernah direservasi (SKU belum terpetakan) tidak menyentuh stok dan masalahnya tetap terbuka di `order_problem`.

**shipment**: `pending → arranged → label_ready → packed → handed_over → in_transit → delivered`; dari `in_transit` boleh ke `failed`; `failed → rto_in_transit → rto_received`; `cancelled` dari `pending`, `arranged`, `label_ready`, `packed`. Via `marketplace`: `pending → label_ready`; `arranged`, `label_ready`, `packed` ke `in_transit` atau `delivered`; `handed_over` ke `delivered` atau `failed`; `in_transit → rto_in_transit`; `failed` ke `in_transit` atau `delivered` (pengiriman ulang). Masuk `rto_received` memicu `return_request` berjenis `rto`.

**return_request**: `requested → seller_review → accepted | rejected`; `accepted → in_transit → received → completed`; `rejected → disputed → accepted | completed`; `cancelled` dari `requested`, `seller_review`; `rto`: `requested → in_transit → received → completed`.

**purchase_order**: `draft → sent → partially_received → received`; `sent → received`; `cancelled` dari `draft`, `sent`.

**stock_count**: `draft → counting → review → applied`; `cancelled` dari `draft`, `counting`, `review`. Masuk `applied`: satu `count_apply` per baris dengan `diff <> 0`.

**stock_transfer**: `draft → sent → received`; `cancelled` dari `draft`, `sent`. Masuk `sent`: `transfer_out` di gudang asal; masuk `received`: `transfer_in` di gudang tujuan sebesar `received_qty`, selisih dicatat sebagai `adjustment` dengan alasan `transfer_shortage`.

**sync_job**: `queued → running → succeeded | failed | skipped`; `queued → skipped`; `failed → queued` (ulang).

**migration_job**: `uploaded → validating → validated | invalid`; `validated → importing → imported | failed`.

**store.status** dan **store.sync_mode** tidak memakai trigger transisi; diubah service dengan aturan di `modules/channel/README.md`.

### 7.10 Indeks dan aturan query

- Setiap indeks pada tabel milik tenant diawali `tenant_id`, kecuali indeks unik global yang disebut eksplisit (`store(channel, external_shop_id)`, `webhook_inbox(source, event_id)`).
- Paginasi cursor memakai `id` (ULID) sebagai kursor: `WHERE id < $cursor ORDER BY id DESC LIMIT $n`. Untuk urutan lain (misalnya `ship_by_at`), kursor gabungan `(ship_by_at, id)`.
- Tidak ada `SELECT *` di repository. Kolom dipilih eksplisit; kolom pribadi pembeli hanya dipilih oleh endpoint yang memerlukannya.
- Kunci baris untuk perubahan status: `SELECT ... FOR UPDATE` pada baris `order` sebelum mengubah item, reservasi, atau status. Urutan kunci tetap: `order` lalu `inventory` (urut `variant_id`, `warehouse_id`) untuk mencegah deadlock.
- `EXPLAIN ANALYZE` wajib dilampirkan di PR untuk query baru pada tabel terpartisi.

---

## 8. Lapisan Aplikasi

### 8.1 Siklus satu permintaan HTTP

Urutan komponen NestJS di proses `api`. NestJS selalu menjalankan middleware, lalu guard, lalu interceptor, lalu pipe, sehingga semua pemeriksaan identitas dan izin terjadi sebelum body divalidasi:

1. `RequestIdMiddleware` (`common/context`): membaca `X-Request-Id` dari Cloudflare atau membuat ULID baru, menaruhnya di `AsyncLocalStorage` bersama `trace_id`. Setiap log di permintaan ini membawa `request_id`, lalu `tenant_id` dan aktor setelah langkah 2.
2. `AuthGuard` (`modules/auth/auth.guard.ts`, guard global): route `@Public()` dilewati. Selain itu: membaca cookie `os_session`, memuat sesi dari Redis, memuat ulang pengguna, izin, dan cakupan dari basis data (perubahan peran berlaku di permintaan berikutnya, tanpa menunggu sesi habis), mencabut sesi bila pengguna tidak lagi `active`, menolak tenant `suspended` atau `closed` (403 `tenant.inactive`), menolak metode tulis pada tenant `closing` (403 `tenant.read_only`), mengambil token dari bucket per tenant (600 per menit, header `X-RateLimit-Remaining`), lalu membentuk `RequestContext`. `Authorization: Bearer` untuk mobile, API key, dan perangkat menyusul di guard yang sama.
3. `PermissionGuard` (guard global): memeriksa `@RequirePermission('order:accept')` terhadap izin di `RequestContext`. Cakupan toko dan gudang diperiksa di service terhadap `ctx.storeScope` dan `ctx.warehouseScope` saat sumber daya dimuat, karena id toko atau gudang sering baru diketahui dari baris itu; `ScopeGuard` generik ditambahkan bila pola ini berulang di modul pesanan dan stok.
4. `AppValidationPipe` (`common/http/validation.ts`, pipe global): memvalidasi `params`, `query`, dan `body` dengan DTO `createZodDto`. Setiap parameter tervalidasi wajib bertipe DTO Zod (`strictSchemaDeclaration`); gagal validasi berarti 422 `validation.failed` dengan `errors[]`. Parameter dekorator kustom seperti `@Ctx()` dilewati karena isinya dibangun server.
5. Controller memanggil service dengan `ctx` sebagai argumen pertama.
6. `ZodSerializerInterceptor` (nestjs-zod): memvalidasi dan memangkas keluaran terhadap `@ZodResponse`, sehingga kolom yang tidak dideklarasikan (misalnya `password_hash`) tidak pernah terkirim. Saat ini gagal keras (500) di semua lingkungan; mode catat-saja untuk produksi diputuskan sebelum rilis.
7. `ProblemDetailsFilter`: mengubah setiap error menjadi RFC 9457 (8.7), termasuk `Retry-After` untuk `rate.limited`.

### 8.2 Konteks permintaan

```ts
export interface RequestContext {
  requestId: string;          // ULID
  traceId: string;            // dari OpenTelemetry
  tenantId: string;           // ULID
  actor: { type: "user" | "api_key" | "device" | "system"; id: string };
  permissions: ReadonlySet<string>;
  storeScope: ReadonlySet<string> | null;      // null berarti semua toko
  warehouseScope: ReadonlySet<string> | null;
  locale: "id" | "en";
}
```

Diakses lewat `ctx()` dari `common/context`. Service menerima `ctx` sebagai parameter pertama secara eksplisit, tidak membaca `AsyncLocalStorage` sendiri, agar mudah diuji dan dipakai dari job.

### 8.3 Transaksi tenant

- `withTenantTx(handle, ctx, async (tx) => { ... })` adalah satu-satunya cara membaca dan menulis data tenant. `handle` adalah pool role `api` atau `worker` (pool `system` ditolak). Ia membuka transaksi, menetapkan `app.tenant_id`, `app.actor_type`, `app.actor_id`, dan `app.request_id` dalam satu pernyataan, lalu menjalankan fungsi.
- Transaksi bersarang untuk tenant yang sama memakai savepoint dari transaksi luar (dilacak dengan `AsyncLocalStorage`), walaupun pemanggil dalam mengoper pool, bukan `tx`. Transaksi untuk tenant berbeda dalam satu alur dilarang dan dideteksi helper (melempar `CrossTenantTxError`).
- `statement_timeout` 5 detik dan `idle_in_transaction_session_timeout` 10 detik ditetapkan pada role `omniseller_api` dan `omniseller_worker` (60 detik untuk `omniseller_system`). Pekerjaan panjang (impor, laporan) memecah pekerjaan menjadi banyak transaksi kecil.
- `withSystemTx(handle, fn)` menolak pool selain `omniseller_system` dan menolak dipanggil di dalam transaksi tenant.
- `withStatusSource(tx, 'marketplace', fn)` menandai perubahan status di dalam `fn` sebagai fakta dari marketplace (7.9) dan mengembalikannya ke `'app'` sesudahnya.
- `tx.execute(sql...)` mentah mengembalikan `timestamptz` sebagai string (Drizzle menyerahkan tanggal ke pemeta kolomnya). Repository memakai query builder Drizzle agar tanggal menjadi `Date`; `int8` (uang, jumlah) selalu menjadi `number` lewat parser global yang menolak nilai di luar batas aman.

### 8.4 Repository

- Satu kelas repository per agregat, menerima `tx` di setiap metode: `findById(tx, id)`, `lockById(tx, id)` (`FOR UPDATE`), `insert(tx, row)`, `update(tx, id, patch, expectedRowVersion)`, `list(tx, filter, cursor)`.
- Tidak ada aturan bisnis, tidak ada pemanggilan service lain, tidak ada transaksi sendiri.
- Kolom dipilih eksplisit. Metode yang mengembalikan data pribadi pembeli diberi akhiran `WithBuyer` agar terlihat di tinjauan.
- Hasil selalu dipetakan ke tipe domain dari `packages/shared`, bukan tipe baris Drizzle mentah, agar perubahan skema tidak merembet ke service.

### 8.5 Event domain dan outbox

| Jenis | Pola nama | Contoh | Tujuan |
|---|---|---|---|
| Fakta (sudah terjadi) | `<agregat>.<kata_kerja_lampau>` | `order.created`, `order.status_changed`, `inventory.changed`, `listing.mapped` | Konsumen dalam sistem: pusher stok, notifikasi, indeks pencarian, laporan |
| Permintaan ke luar | `<agregat>.<aksi>_requested` | `order.accept_requested`, `shipment.arrange_requested`, `listing.price_push_requested` | Job yang memanggil connector |

Aturan:

- Skema payload setiap event didefinisikan Zod di `<modul>.events.ts` dan diekspor ke `packages/shared` bila dikonsumsi modul lain.
- Event ditulis dengan `outbox.enqueue(tx, event)` dalam transaksi yang sama dengan perubahan data. Tidak ada `queue.add()` langsung dari service.
- Payload berisi id dan data minimum yang diperlukan konsumen. Konsumen memuat ulang keadaan terkini dari basis data; tidak pernah mengandalkan payload sebagai kebenaran.
- Konsumen idempoten: memeriksa keadaan sebelum bertindak (misalnya tidak memanggil `accept` bila `order.status` sudah melewati `ready_to_pack`).
- Pemanggilan lintas modul yang sinkron dilakukan lewat service publik modul pemilik (`InventoryService.reserve`), bukan lewat repository modul lain dan bukan lewat event.

### 8.6 Connector dan kredensial

- `ConnectorRegistry.forStore(tx, storeId)` mengembalikan `BoundConnector`: connector marketplace yang sudah terikat `ShopCtx` (id toko eksternal, region, penyedia token, pembatas laju).
- `CredentialService.getAccessToken(storeId)` hanya tersedia di proses `worker` dan `scheduler`. Ia mendekripsi dengan DEK tenant dari KMS (cache DEK 10 menit di memori proses) dan memperbarui token bila tersisa kurang dari 20% masa hidup.
- **Refresh token dikunci per toko.** Beberapa marketplace merotasi refresh token dan hanya menerima satu pemakaian. Karena `CredentialService` (saat dipakai job) dan jadwal `token.refresh_scan` dapat merefresh toko yang sama bersamaan, refresh dilakukan di dalam transaksi yang mengunci baris `store_credential` (`SELECT ... FOR UPDATE`), lalu memeriksa ulang masa berlaku sesudah kunci didapat, sebelum memanggil marketplace.
- **Otorisasi toko (OAuth) selesai di worker.** Proses `api` menerima redirect dari marketplace, memeriksa `state`, lalu menulis event `store.authorization_received` (berisi kode otorisasi sekali pakai) ke outbox. Job di worker menukar kode dengan token, mengenkripsinya dengan DEK tenant, dan menulis `store_credential`. Dengan begitu proses `api` tidak pernah melakukan panggilan keluar (I4), tidak memegang hak KMS, dan tidak dapat menulis maupun membaca token (I12). Kode otorisasi menjadi tidak berguna setelah ditukar.
- Setiap panggilan connector dicatat ke `sync_job` oleh `ConnectorCallInterceptor` dengan ringkasan permintaan dan respons yang sudah disamarkan.
- Error connector dipetakan ke `TransientConnectorError` (diulang BullMQ), `AuthExpiredError` (refresh lalu ulang sekali), atau `PermanentConnectorError` (tidak diulang, `sync_job.status = failed`, notifikasi ke pengguna).

### 8.7 Error

Hierarki di `common/errors`:

| Kelas | HTTP | Kode contoh | Kapan |
|---|---|---|---|
| `ValidationError` | 422 | `validation.failed` | Input tidak lolos Zod atau aturan bisnis bentuk data |
| `UnauthorizedError` | 401 | `auth.required`, `auth.invalid_token` | Tidak ada atau salah identitas |
| `ForbiddenError` | 403 | `auth.permission_denied`, `auth.scope_denied` | Izin atau cakupan kurang |
| `NotFoundError` | 404 | `order.not_found` | Tidak ditemukan, termasuk milik tenant lain (RLS) |
| `ConflictError` | 409 | `row.stale`, `stock.insufficient`, `order.invalid_transition`, `listing.already_mapped` | Keadaan bertentangan |
| `PreconditionError` | 412 | `warehouse.unmapped`, `store.read_only` | Prasyarat belum terpenuhi |
| `RateLimitedError` | 429 | `rate.limited` | Batas laju |
| `ExternalServiceError` | 502 | `marketplace.unavailable` | Marketplace atau layanan luar gagal |
| `InternalError` | 500 | `internal` | Bug; selalu dikirim ke Sentry |

Pemetaan error PostgreSQL ada di `common/errors/problem.ts` (`toDomainError`), dipakai `ProblemDetailsFilter`:

| Sumber | Hasil |
|---|---|
| Pesan dari fungsi SQL (`STOCK_INSUFFICIENT`, `INVALID_STATUS_TRANSITION`, `STOCK_REASON_REQUIRED`, `STOCK_INVENTORY_MISSING`) | Kode khusus: `stock.insufficient` (409), `status.invalid_transition` (409), `validation.failed` (422), `stock.inventory_missing` (404) |
| Pesan pelanggaran invarian (`TENANT_MISMATCH`, `INVENTORY_DIRECT_WRITE_FORBIDDEN`, `AUDIT_LOG_IMMUTABLE`) | 500 `internal.*`, karena itu bug di kode aplikasi |
| `23505` (unik) | 409; batasan yang bermakna bisnis dipetakan ke kode khusus (`store_channel_external_shop_uq` menjadi `store.already_connected`), sisanya `row.duplicate` |
| `23503` (kunci asing) | Saat menyisipkan: 412 `row.reference_missing`. Saat menghapus induk yang masih dirujuk: 409 `row.in_use` |
| `23514`, `23502` | 409 `row.constraint_failed` |
| `40001`, `40P01` | 409 `tx.conflict` |
| Lainnya | 500; rincian hanya ke log dan Sentry, tidak pernah ke respons |

Pesan fungsi dan trigger memakai kode huruf besar dengan garis bawah sebagai `MESSAGE` agar dapat dipetakan. Drizzle membungkus error driver, sehingga pemetaan menelusuri rantai `cause`.

### 8.8 Penguncian optimistik

- Setiap `PATCH` dan `PUT` menerima header `If-Match: "<row_version>"` opsional. Bila ada, `update` memakai `WHERE id = $1 AND row_version = $2`; nol baris berarti `ConflictError('row.stale')`.
- UI selalu mengirim `If-Match` untuk formulir edit. API publik boleh mengabaikannya.
- Untuk pesanan dan stok, penguncian pesimistik (`FOR UPDATE`) tetap dipakai di dalam service karena beberapa proses menulis bersamaan.

### 8.9 Serialisasi

- Tanggal dan waktu dalam ISO 8601 dengan zona UTC (`2026-09-30T04:15:00Z`). Klien mengonversi ke zona tenant.
- Uang sebagai integer rupiah. Tidak ada string berformat.
- Id sebagai string ULID.
- Kolom internal (`*_enc`, `*_hash`, `row_version` kecuali di header `ETag`, `raw_payload_ref`) tidak pernah keluar.
- `ETag: "<row_version>"` disertakan pada respons satu sumber daya.

### 8.10 Sesi, sandi, dan batas laju

Implementasi di `common/security/` dan modul `auth`. Nilai di bawah adalah konstanta di kode, bukan variabel lingkungan.

| Hal | Keputusan |
|---|---|
| Sesi web | Token acak 256 bit di cookie `os_session` (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` di luar `local` dan `test`). Redis `redis-cache` menyimpan `sess:<sha256 token>`, bukan token mentah. Masa berlaku 30 hari bergeser (diperpanjang paling sering sekali per jam), maksimal 10 sesi per pengguna (sesi terlama dicabut) |
| Pencabutan sesi | Semua sesi pengguna dicabut saat dinonaktifkan dan saat sandi diatur ulang. Ganti sandi sendiri mencabut semua sesi lain dan mempertahankan sesi saat ini. Logout mencabut satu sesi |
| Sandi | Argon2id (m=65536 KiB, t=3, p=4), 10 sampai 128 karakter. Hash lama dengan parameter lebih lemah diperbarui saat login berhasil |
| Penguncian | 5 kali gagal berturut-turut mengunci akun 15 menit. Akun terkunci ditolak **sebelum** sandi diperiksa, sehingga respons tidak membocorkan benar atau salahnya sandi selama terkunci. Email yang tidak terdaftar tetap menjalankan verifikasi tiruan agar waktu respons sama |
| Login multi-tenant | Email yang sama di beberapa tenant: bila sandi cocok di lebih dari satu tenant aktif, respons 409 `auth.tenant_choice_required` berisi daftar tenant, lalu klien mengulang dengan `tenant` (slug) |
| Batas laju (token bucket Lua di Redis) | Login 20 per menit per IP dan 10 per 15 menit per email; daftar 5 per jam per IP; permintaan atur ulang sandi 5 per 15 menit per IP dan 3 per jam per email (batas per email diam: tetap 202); API 600 per menit per tenant. IP dibaca dari `CF-Connecting-IP` |
| Token undangan dan atur ulang | 256 bit, hanya hash SHA-256 disimpan, dibuat oleh job di worker (bukan oleh request), sehingga token mentah hanya pernah ada di email. Undangan berlaku 72 jam, atur ulang sandi 60 menit, sekali pakai |
| Permintaan atur ulang sandi | Selalu 202 tanpa membedakan email terdaftar atau tidak |

---

## 9. Pekerjaan Latar dan Penjadwalan

### 9.1 Definisi job

Job milik modul didefinisikan di `modules/<modul>/<modul>.jobs.ts` dengan `defineJob`, diekspor sebagai larik (misalnya `IDENTITY_JOBS`), dan didaftarkan di `jobs/registry.ts`:

```ts
export const orderAcceptRequested = defineEvent({
  type: "order.accept_requested",
  aggregate: "order",
  schema: z.object({ orderId: ulidSchema }),
});

export const acceptOrderJob = defineJob({
  queue: "mp.outbound",
  name: "order.accept",
  schema: z.object({ orderId: ulidSchema }),          // tenantId ditambahkan kerangka
  triggeredBy: [orderAcceptRequested],
  options: { attempts: 5, backoff: { type: "exponential", delay: 2_000 } },
  jobId: (p) => jobKey("order.accept", p.orderId),    // sekali per pesanan
  handler: async (p, run) => {
    await run.deps.resolve(OrdersService).processAccept(run.ctx, p.orderId);   // run.ctx: aktor system di tenant p.tenantId
  },
});
```

Service menulis event dengan `outbox.enqueue(tx, ctx, orderAcceptRequested, { orderId }, orderId)`; setiap job yang mencantumkan event itu di `triggeredBy` mendapat baris outbox sendiri. `jobs/registry.ts` (`JOB_DEFINITIONS`) memuat semua job. Worker membuat satu BullMQ Worker per antrean yang punya job terdaftar; payload divalidasi skema job sebelum handler dipanggil. Handler mengambil service lewat `run.deps.resolve(KelasService)`, yang meminta instance dari container NestJS proses worker; modul pemilik service cukup diimpor di peran `worker` pada `app.module.ts`.

### 9.2 Kunci idempoten

Id dibuat dengan `jobKey(...bagian)` yang menggabungkan bagian dengan `|`. BullMQ 5 menolak id kustom yang mengandung `:` (kecuali tepat tiga bagian, format lama untuk repeatable job), sehingga format `order.accept:<order_id>` di versi 1.0 dokumen ini akan gagal saat runtime.

BullMQ menolak job dengan `jobId` yang masih ada di antrean **atau yang sudah selesai tetapi masih disimpan** (`removeOnComplete: { age: 3600 }`). Karena itu ada dua jenis id:

- **Sekali per entitas**: aksi yang paling banyak terjadi sekali, cukup kunci bisnis. Permintaan ganda (klik dua kali, relay ulang) otomatis diabaikan.
- **Per kejadian**: aksi yang sah berulang untuk entitas yang sama dalam satu jam. Id menyertakan kunci kejadian (id baris outbox atau skor debounce). Dengan kunci bisnis saja, dorongan kedua dalam satu jam akan dibuang diam-diam oleh BullMQ.

| Job | Jenis | `jobId` |
|---|---|---|
| `order.ingest` | Sekali per event webhook | `order.ingest\|<store_id>\|<event_id>` |
| `order.accept` | Sekali per entitas | `order.accept\|<order_id>` |
| `shipment.arrange` | Sekali per entitas | `shipment.arrange\|<shipment_id>` |
| `label.fetch` | Sekali per entitas | `label.fetch\|<shipment_id>` |
| `stock.push` | Per kejadian | `stock.push\|<variant_id>\|<warehouse_id>\|<skor debounce>` (9.4) |
| `listing.price_push` | Per kejadian | `listing.price_push\|<listing_id>\|<outbox_event_id>` |
| `settlement.import` | Sekali per periode | `settlement.import\|<store_id>\|<period_start>` |
| `notify.send` | Sekali per notifikasi dan kanal | `notify.send\|<notification_id>\|<channel>` |
| `ai.chat_suggest` | Sekali per pesan | `ai.chat_suggest\|<message_id>` |
| `research.capture` | Sekali per jam | `research.capture\|<research_item_id>\|<yyyy-mm-dd-hh>` |
| `mp.poll.orders` | Sekali per slot | `mp.poll.orders\|<store_id>\|<slot>` dengan `slot` = waktu dibulatkan 5 menit |

Handler tetap memeriksa keadaan bisnis sebelum bertindak dan memuat ulang nilai terkini dari basis data, sehingga dua job untuk entitas yang sama selalu mengirim nilai terbaru.

### 9.3 Payload dan handler

- Payload hanya berisi id dan parameter, tidak pernah objek lengkap.
- Handler memanggil service dengan `helpers.systemCtx(tenantId)` yang membuat `RequestContext` bertipe aktor `system` dan izin penuh dalam tenant itu.
- Handler menulis `sync_job` untuk setiap panggilan connector lewat interceptor, bukan manual.
- Handler yang memanggil connector wajib mendapatkan izin dari `StoreRateLimiter.acquire(storeId)`; bila ditolak, job dipindahkan ke tunda (`moveToDelayed`) dengan jitter, bukan dianggap gagal.

### 9.4 Pusher stok

Implementasi: `jobs/stock-dirty.ts` (`StockDirtySet`) dan `scheduler/stock-flush.ts`.

1. Setiap `inventory.changed` (dari `apply_stock_movement` melalui service) menulis kunci `tenant_id:variant_id:warehouse_id` ke sorted set Redis `stock:dirty` dengan skor waktu (ms). Menandai ulang memajukan skor, sehingga kunci baru siap setelah diam 5 detik.
2. Scheduler setiap 2 detik **membaca** kunci yang skornya lebih tua dari 5 detik (tanpa menghapus), menambahkan job `stock.push` per kunci dengan id yang menyertakan skor, lalu **mengakui** tiap kunci dengan skrip Lua yang menghapusnya hanya bila skornya belum berubah. Urutan ini menjamin: perubahan yang datang di antara baca dan akui tidak hilang (kunci tetap ada dengan skor baru), dan scheduler yang mati sebelum mengakui akan menambahkan id yang sama lagi, yang dibuang BullMQ.
3. Handler `stock.push` membuka `withTenantTx`, membaca `inventory.available` terkini, menghitung alokasi per `channel_listing` dan `channel_warehouse` yang terpetakan ke gudang itu sesuai `stock_allocation_rule`, membandingkan dengan `listing_stock_state.last_pushed_qty`, dan hanya mengirim nilai yang berubah. Handler memegang kunci Redis per `(variant, warehouse)`; bila kunci sedang dipegang job lain, handler menandai ulang kunci dirty lalu selesai, sehingga dua dorongan untuk pasangan yang sama tidak pernah berjalan bersamaan dan nilai lama tidak menimpa nilai baru.
4. Nilai dikirim sebagai angka absolut `GREATEST(available_alokasi, 0)`. Sukses memperbarui `listing_stock_state`; gagal menaikkan `push_fail_count` dan job diulang.
5. Toko dengan `sync_mode = 'read_only'` atau `channel_warehouse.mapping_status <> 'mapped'` dilewati dan dicatat sebagai `sync_job.status = skipped`.

Langkah 1 dan 2 sudah diimplementasikan dan diuji; langkah 3 sampai 5 dibangun bersama connector pertama.

### 9.5 Jadwal berulang

| Nama | Jadwal | Role basis data | Tugas |
|---|---|---|---|
| `outbox.relay` | Setiap 1 detik dan saat `NOTIFY outbox` | `system` | Relay `outbox_event` ke BullMQ |
| `stock.dirty_flush` | Setiap 2 detik | tidak ada (hanya Redis) | Enqueue `stock.push` |
| `webhook.inbox_sweep` | Setiap 30 detik | `system` | Enqueue ulang baris `webhook_inbox` yang belum diproses, untuk webhook yang diterima saat Redis mati (DOKUMEN-TEKNOLOGI 8.3); menyusul bersama proses webhook |
| `token.refresh_scan` | Setiap 15 menit | `system` untuk memilih, `worker` per toko | Refresh token yang tersisa kurang dari 20% masa hidup |
| `mp.poll.orders` | Setiap 5 menit per toko aktif | `worker` | Polling cadangan pesanan |
| `mp.poll.products` | Setiap 6 jam per toko | `worker` | Sinkron listing |
| `mp.poll.warehouses` | Setiap 6 jam per toko | `worker` | Daftar gudang marketplace, deteksi perubahan |
| `settlement.pull` | Harian 03.00 WIB | `worker` | Tarik settlement |
| `health.snapshot` | Harian 05.00 WIB | `worker` | Metrik performa toko |
| `boost.tick` | Setiap 5 menit | `worker` | Naikkan produk sesuai jadwal |
| `promo.auto_renew` | Setiap jam | `worker` | Perpanjang promo yang berakhir |
| `campaign.tick` | Setiap 10 menit | `system` | Aktifkan mode kampanye, cadangan stok |
| `sla.refresh` | Setiap menit | `system` | Kirim peringatan pesanan hampir terlambat. Status SLA di layar dihitung saat dibaca dari `ship_by_at` dan `internal_ship_by_at`, tidak disimpan sebagai kolom |
| `partition.maintain` | Saat scheduler mulai dan setiap 6 jam | `system` | `maintain_partitions(now())`; pelepasan partisi kedaluwarsa menyusul bersama job arsip |
| `retention.run` | Harian 02.00 WIB | `system` | Hapus `webhook_inbox` lebih dari 30 hari, `outbox_event` terkirim lebih dari 7 hari, anonimkan pembeli sesuai kebijakan, ringkas `research_snapshot` |
| `research.collect` | Setiap 6 jam per tautan pantauan | `worker` | Pengumpulan riset |
| `billing.usage_close` | Bulanan tanggal 1 pukul 00.10 WIB | `system` | Tutup `usage_counter`, reset `ai_budget` |
| `dlq.alert` | Setiap 5 menit | `system` (hanya Redis) | Alarm bila DLQ melewati ambang |

Semua jadwal memakai zona `Asia/Jakarta` secara eksplisit di definisi cron. Loop cepat (`outbox.relay`, `stock.dirty_flush`, `partition.maintain`) berjalan di dalam proses scheduler (`scheduler/scheduler.runner.ts`); jadwal per toko dan jadwal harian memakai BullMQ job scheduler dan ditambahkan bersama modulnya. Semua loop idempoten, sehingga dua scheduler yang tumpang tindih sebentar saat deploy blue/green tetap aman.

### 9.6 Dead letter queue

- Job yang habis percobaan dipindahkan ke antrean `<nama>.dlq` dengan payload asli dan error terakhir.
- UI admin internal menampilkan DLQ per antrean dengan tombol ulang dan buang. Perintah `pnpm jobs:retry --queue mp.outbound --id <jobId>` untuk operasional.
- Job di DLQ yang menyangkut pesanan menambahkan `order_problem` berkode `fulfillment_conflict` agar terlihat pengguna.

---

## 10. Aturan API

### 10.1 Bentuk endpoint

| Aturan | Contoh |
|---|---|
| Prefix versi | `/v1/...` |
| Kata benda jamak, kebab-case | `/v1/orders`, `/v1/channel-listings`, `/v1/stock-counts` |
| Satu sumber daya | `GET /v1/orders/{id}` |
| Aksi pada sumber daya | `POST /v1/orders/{id}/accept`, `POST /v1/orders/{id}/cancel` |
| Aksi massal | `POST /v1/orders/batch/accept` dengan `{ ids: [...] }`, mengembalikan `202` dan `{ job_id }`; progres di `GET /v1/jobs/{job_id}` |
| Sub-sumber daya | `GET /v1/orders/{id}/events` |
| Filter | `?status=new,problem&store_id=...&ship_by_before=2026-10-01T00:00:00Z` |
| Urutan | `?sort=-ship_by_at,id` (awalan `-` untuk menurun); default `-id` |
| Paginasi | `?cursor=...&limit=50`; respons `{ items: [], next_cursor }` dengan `next_cursor` berupa string atau null |
| Pencarian teks | `?q=` diteruskan ke Meilisearch, hasil id lalu dimuat dari basis data |
| Webhook masuk | `POST /webhooks/{channel}` tanpa prefix versi, ditangani proses `webhook` |
| Kesehatan | `GET /healthz` (proses hidup), `GET /readyz` (basis data dan Redis terjangkau) |

### 10.2 Header

| Header | Arah | Keterangan |
|---|---|---|
| `Authorization: Bearer` | Masuk | Token mobile, ekstensi, API key, perangkat (menyusul) |
| Cookie `os_session` | Masuk | Sesi web (8.10). CORS hanya untuk origin `PUBLIC_WEB_URL` dengan `credentials` |
| `Idempotency-Key` | Masuk | Wajib untuk `POST` yang memicu efek luar; disimpan 24 jam di Redis bersama hash body; body berbeda dengan kunci sama berarti 422 |
| `If-Match` | Masuk | Penguncian optimistik (8.8); versi basi berarti 409 `row.stale` |
| `X-Request-Id` | Keduanya | Diteruskan dan dikembalikan |
| `ETag` | Keluar | `row_version` |
| `X-RateLimit-Remaining`, `Retry-After` | Keluar | Batas laju |

### 10.3 Kontrak respons

- Satu sumber daya: objek langsung, tanpa pembungkus.
- Daftar: `{ items, next_cursor }`.
- Aksi asinkron: `202 Accepted` dengan `{ job_id, status_url }`.
- Error: `application/problem+json` dengan `type` (URL dokumentasi kode), `title`, `status`, `detail`, `instance` (request id), `code`, `errors[]` opsional berisi `{ path, message }`.

### 10.4 OpenAPI dan klien

- `pnpm openapi:emit` membangun aplikasi lalu menulis `openapi.json` (OpenAPI 3.1) dari dekorator dan skema Zod (`nestjs-zod` mengubah skema menjadi JSON Schema, `@ZodResponse` mendeklarasikan respons). Berkas ini di-commit. Di luar produksi, Swagger UI tersedia di `/docs`.
- Setiap operasi membawa ekstensi `x-isolation` (dari `@Isolation(...)` atau `@Public()`), yang dibaca uji isolasi tenant (13.3).
- `pnpm openapi:client` menghasilkan `packages/api-client` (openapi-typescript dan openapi-fetch).
- CI membandingkan `openapi.json` dengan cabang utama memakai `oasdiff`; perubahan yang memutus kompatibilitas pada `/v1` menggagalkan CI kecuali PR diberi label `api-breaking` dan menaikkan versi.

### 10.5 Izin

Kode izin berbentuk `modul:aksi`. Daftar lengkap ada di `permission` (seed) dan `packages/shared/src/permissions.ts`. Contoh:

| Izin | Endpoint |
|---|---|
| `order:read` | `GET /v1/orders*` |
| `order:accept`, `order:cancel`, `order:tag` | Aksi pesanan |
| `shipment:arrange`, `shipment:print`, `shipment:handover` | Pengiriman |
| `inventory:read`, `inventory:adjust`, `inventory:count`, `inventory:transfer` | Stok |
| `catalog:write`, `catalog:publish`, `catalog:map` | Katalog |
| `price:write`, `promo:write` | Harga dan promosi |
| `finance:read`, `finance:reconcile`, `finance:export` | Keuangan |
| `chat:read`, `chat:write`, `chat:assign` | Chat |
| `settings:store`, `settings:warehouse`, `settings:user`, `settings:billing` | Pengaturan |
| `research:read`, `research:write` | Riset |
| `admin:internal` | UI admin internal OmniSeller (bukan tenant) |

### 10.6 Endpoint yang sudah ada

| Endpoint | Izin | Keterangan |
|---|---|---|
| `POST /v1/auth/signup` | Publik | Membuat tenant (paket starter, slug unik), enam peran bawaan, Owner, dan gudang `UTAMA`; 201 dengan sesi |
| `POST /v1/auth/login`, `POST /v1/auth/logout` | Publik; sesi | 8.10. Logout 204 |
| `POST /v1/auth/password-reset`, `POST /v1/auth/password-reset/confirm` | Publik | 202 lalu email; konfirmasi 204 dan mencabut semua sesi |
| `POST /v1/auth/invitations/inspect`, `POST /v1/auth/invitations/accept` | Publik | Token di body, bukan di URL, agar tidak tercatat di log akses. Terima membuat pengguna dengan peran undangan dan langsung masuk (201) |
| `GET /v1/me`, `POST /v1/me/password` | Sesi | Profil, tenant, izin, cakupan; ganti sandi sendiri |
| `GET /v1/users`, `GET/PATCH /v1/users/{id}`, `PUT /v1/users/{id}/roles`, `PUT /v1/users/{id}/scopes` | `settings:user` | `GET` satu pengguna mengembalikan `ETag`, `PATCH` menerima `If-Match` (8.8). Ditolak: menonaktifkan diri sendiri, menghapus Owner aktif terakhir, memberi peran yang izinnya tidak dimiliki pemberi (403 `role.privilege_escalation`). Menonaktifkan pengguna mencabut semua sesinya |
| `GET /v1/roles`, `GET /v1/permissions` | `settings:user` | |
| `GET/POST /v1/invitations`, `POST /v1/invitations/{id}/resend`, `DELETE /v1/invitations/{id}` | `settings:user` | Satu undangan terbuka per email; kirim ulang membatalkan tautan lama |
| `GET /v1/audit-logs` | `audit:read` | Filter `entity_type`, `entity_id` |

---

## 11. Peta Modul dan Kepemilikan Tabel

| Modul | Tabel yang dimiliki (hanya modul ini yang menulis) | Event diterbitkan | Event dikonsumsi | Job utama |
|---|---|---|---|---|
| `identity` | `tenant`, `user`, `role`, `permission`, `role_permission`, `user_role`, `user_store_scope`, `user_warehouse_scope`, `invitation`, `api_key`, `device`; membuat gudang `UTAMA` saat daftar lewat repository-nya sendiri sampai modul `inventory` ada | `invitation.send_requested`; menyusul `tenant.created`, `user.role_changed` | `subscription.changed` (menyusul) | `identity.invite_email` (antrean `notify`) |
| `auth` | `password_reset_token`, `refresh_token` (menyusul bersama mobile), sesi di Redis | `password_reset.requested` | | `auth.password_reset_email` (antrean `notify`) |
| `channel` | `store`, `store_credential`, `channel_warehouse`, `sync_cursor` | `store.connected`, `store.disconnected`, `store.reauth_required`, `channel_warehouse.changed`, `store.sync_mode_changed` | | `store.initial_import`, `token.refresh`, `mp.poll.warehouses` |
| `catalog` | `product`, `variant`, `product_image`, `bundle_component`, `channel_listing`, `listing_stock_state` | `listing.mapped`, `listing.unmapped`, `variant.price_changed`, `variant.cost_changed`, `listing.price_push_requested`, `listing.status_push_requested` | `store.connected` | `listing.pull`, `listing.price_push`, `listing.status_push`, `listing.copy` |
| `inventory` | `warehouse`, `inventory`, `stock_movement`, `stock_allocation_rule`, `stock_count`, `stock_count_line`, `stock_transfer`, `stock_transfer_line`, `campaign_stock_hold` | `inventory.changed`, `inventory.low_stock` | `order.status_changed`, `return.received`, `goods.received`, `campaign.started`, `campaign.ended` | `stock.push` |
| `purchasing` | `supplier`, `purchase_order`, `purchase_order_line`, `goods_receipt`, `goods_receipt_line`, `document_sequence` | `goods.received`, `purchase_order.status_changed` | `inventory.low_stock` | |
| `orders` | `order`, `order_external_ref`, `order_item`, `order_event`, `order_problem`, `tag`, `order_tag`, `pick_wave` | `order.created`, `order.status_changed`, `order.problem_added`, `order.accept_requested`, `order.cancel_requested` | `webhook.received`, `shipment.status_changed`, `return.status_changed` | `order.ingest`, `order.accept`, `order.cancel`, `mp.poll.orders`, `order.auto_process` |
| `fulfillment` | `shipment`, `shipment_package`, `print_job` | `shipment.status_changed`, `shipment.arrange_requested`, `label.ready`, `print.requested` | `order.status_changed` | `shipment.arrange`, `label.fetch`, `pdf.render`, `pick_list.render` |
| `returns` | `return_request`, `return_item` | `return.status_changed`, `return.received` | `webhook.received`, `shipment.status_changed` | `return.pull`, `return.respond` |
| `sync` | `webhook_inbox`, `sync_job`, `outbox_event` | `webhook.received` | | `outbox.relay` (di scheduler) |
| `finance` | `fee_schedule`, `settlement`, `settlement_line`, `order_cost`, `tax_document`, `expense`, `receivable`, `receivable_entry` | `settlement.imported`, `order_cost.computed`, `tax.threshold_reached` | `order.status_changed`, `return.status_changed`, `affiliate.recorded` | `settlement.pull`, `settlement.import`, `order_cost.compute` |
| `chat` | `chat_thread`, `chat_message`, `chat_template` | `chat.message_received` | `webhook.received` | `chat.pull`, `chat.send`, `ai.chat_suggest` |
| `promo` | `promotion`, `promotion_item`, `boost_schedule`, `boost_schedule_item` | `promo.created`, `promo.renewed` | | `promo.push`, `promo.auto_renew`, `boost.tick` |
| `health` | `shop_health_snapshot` | `health.threshold_crossed` | | `health.snapshot` |
| `affiliate` | `affiliate_order` | `affiliate.recorded` | `order.created` | `affiliate.pull` |
| `crm` | `customer` | `customer.watchlisted` | `order.created`, `return.status_changed`, `shipment.status_changed` | |
| `research` | Semua tabel skema `research` | `research.alert` | | `research.capture`, `research.summarize`, `research.parser_check` |
| `migration` | `migration_job`, `migration_row_error` | `migration.finished`, `store.cutover` | | `migration.validate`, `migration.import` |
| `campaign` | `campaign`, `campaign_plan`, `courier_cutoff`, `operating_hours` | `campaign.started`, `campaign.ended` | | `campaign.tick`, `campaign.evaluate` |
| `notification` | `notification`, `notification_preference` (menyusul). Saat ini menyediakan `EmailSender` (`smtp`, `log`, `memory`) dan templat email bagi job modul lain, hanya di proses worker | | Hampir semua event fakta | `notify.send` |
| `billing` | `plan`, `subscription`, `invoice`, `usage_counter` | `subscription.changed`, `usage.limit_reached` | `order.created` (meter) | `billing.usage_close`, `billing.xendit_webhook` |
| `reporting` | Tidak memiliki tabel; membaca lintas modul lewat view yang dibuat modul pemilik | | | `report.scheduled_email` |
| `ai` | `ai_route_config`, `ai_call_log`, `ai_budget` | `ai.budget_exhausted` | | `ai.*` |
| `files` | `file_object` | | | `files.cleanup_expired` |
| `audit` | `audit_log` (ditulis trigger `audit_row()`, dibaca `GET /v1/audit-logs`) | | | `audit.export_monthly` |
| `platform` | `feature_flag`, `feature_flag_override` | | | |

Aturan: modul lain membaca tabel modul pemilik hanya lewat service publik atau view yang diekspor pemilik. Uji lint `no-cross-module-table-write` memeriksa impor skema Drizzle: `orders.repository.ts` boleh mengimpor `schema/orders.ts` dan tabel referensi, tidak boleh mengimpor `schema/inventory.ts` untuk menulis.

---

## 12. Migrasi Basis Data

### 12.1 Alur

Migrasi ditulis sebagai SQL dan dijalankan migrator sendiri (`src/db/migrate.ts`, ADR-027). Alasannya: sebagian besar DDL yang menjaga integritas di sini (partisi range pada ULID, FK komposit dengan `SET NULL (kolom)`, RLS, grant per role, trigger, fungsi `SECURITY DEFINER`) tidak dapat dinyatakan di skema Drizzle, sehingga SQL yang ditinjau di PR adalah sumber kebenaran dan skema Drizzle menjadi cerminnya.

`pnpm db:migrate` (sebagai `omniseller_migrator`, dengan advisory lock agar dua deploy tidak bermigrasi bersamaan):

1. **Berversi**: setiap `drizzle/migrations/NNNN_nama.sql` yang belum tercatat di `schema_migration` dijalankan sekali, satu transaksi per file, dicatat bersama checksum. File yang sudah diterapkan lalu diubah membuat migrasi berhenti dengan pesan jelas.
2. **Repeatable**: semua `drizzle/sql/*.sql` dijalankan ulang, urut nama file, dalam satu transaksi: `10_functions` (`CREATE OR REPLACE`), `20_triggers` (buat bila belum ada), `30_policies` (RLS), `40_grants` (hak persis per role), `90_seeds`. Harus idempoten.
3. **Partisi**: `maintain_partitions(now())`.

Alur mengubah skema:

1. Tulis migrasi berversi baru `drizzle/migrations/NNNN_<kata_kerja>_<objek>.sql` (nomor berikutnya). Bila perlu fungsi, trigger, kebijakan, atau grant baru, tambahkan ke file repeatable yang sesuai.
2. Perbarui cermin Drizzle di `src/db/schema/<domain>.ts`.
3. `pnpm db:migrate` di lokal, lalu `pnpm test:schema` (kolom Drizzle sama dengan SQL, kolom standar, FK komposit dan daftar kolom `SET NULL`, RLS aktif dan dipaksa, trigger status, tabel terpartisi terdaftar, izin seed sama dengan `packages/shared`).
4. Jalankan uji integrasi.
5. PR dengan checklist 15.11 bagian migrasi.
6. Staging menjalankan migrasi otomatis sebelum deploy. Produksi menjalankan migrasi sebagai tugas ECS satu kali; gagal berarti deploy dibatalkan.

Role dan database dibuat di luar migrasi, karena role berlaku untuk seluruh klaster dan atribut `BYPASSRLS` butuh hak admin: Terraform di AWS, `pnpm db:bootstrap` di lokal dan uji (`src/db/bootstrap.ts`).

### 12.2 Aturan

- Pola expand and contract. Kolom baru selalu `NULL` atau punya `DEFAULT` yang murah; `NOT NULL` ditambahkan di migrasi berikutnya setelah backfill.
- Backfill lewat skrip `tools/scripts/backfill-<nama>.ts` dalam batch 5.000 baris per transaksi, bukan di dalam migrasi.
- Indeks pada tabel besar dibuat `CONCURRENTLY` lewat `tools/scripts/create-index.ts` di luar migrasi (karena tidak bisa dalam transaksi), dan dicatat di tabel `schema_manual_change` agar lingkungan lain tahu.
- Tidak ada `DROP COLUMN` sebelum dua rilis setelah kode berhenti membacanya.
- Migrasi tidak pernah diubah setelah digabung ke `main`. Perbaikan adalah migrasi baru.
- Seed idempoten (`INSERT ... ON CONFLICT`) di `drizzle/sql/90_seeds.sql` untuk `permission`, tabel transisi status, `plan`, dan nanti `research_source`, `ai_route_config`, `campaign` sistem, `feature_flag`. Dijalankan setiap `db:migrate`. Menghapus baris dari daftar seed tidak menghapus barisnya; penghapusan adalah migrasi berversi.

### 12.3 Checklist tinjauan migrasi

- [ ] Setiap tabel baru punya kolom standar 7.2 (atau dicatat sebagai pengecualian di `test/schema`) dan cermin Drizzle-nya.
- [ ] Setiap FK ke tabel tenant komposit `(tenant_id, x_id)` dengan `ON DELETE` yang dipilih sadar; `SET NULL` selalu dengan daftar kolom.
- [ ] RLS dan kebijakan `tenant_isolation` terpasang otomatis oleh `30_policies.sql` untuk tabel yang punya `tenant_id`; pengecualian ditulis eksplisit.
- [ ] Hak baku (CRUD untuk api dan worker) dipasang otomatis oleh `40_grants.sql`; tabel yang butuh hak lebih sempit ditambahkan ke daftar pengecualian di file itu.
- [ ] Trigger `touch_row` terpasang otomatis; trigger status dan audit ditambahkan di `20_triggers.sql` bila perlu.
- [ ] Indeks diawali `tenant_id`.
- [ ] Untuk tabel terpartisi: `PARTITION BY RANGE (id)`, partisi `DEFAULT` di migrasi, dan tabelnya ditambahkan ke `partition_targets()`.
- [ ] Tidak ada operasi destruktif pada rilis yang sama dengan kode yang bergantung.

---

## 13. Pengujian Backend

### 13.1 Jenis dan letak

| Jenis | Berkas | Basis data | Menjalankan |
|---|---|---|---|
| Unit | `*.spec.ts` di samping kode | Tidak ada (repository di-mock) | `pnpm test` |
| Integrasi | `*.int.spec.ts` (di samping kode atau di `test/`) | Database baru per run (Testcontainers atau `TEST_PG_ADMIN_URL`), role `omniseller_api`, `omniseller_worker`, atau `omniseller_system` sesuai proses yang diuji, **bukan superuser**, agar RLS dan grant ikut teruji | `pnpm test:int` |
| Skema | `test/schema/*.int.spec.ts` | Sama dengan integrasi | `pnpm test:schema` |
| Isolasi tenant | `test/tenant-isolation/isolation.int.spec.ts`, digerakkan dokumen OpenAPI yang dibangun dari aplikasi | Sama dengan integrasi | `pnpm test:isolation` |
| E2E API | `test/e2e/*.e2e.int.spec.ts` | Sama dengan integrasi, ditambah server tiruan saat connector ada | `pnpm test:int` (skrip `test:e2e` terpisah menyusul) |
| Kontrak connector | `packages/connectors/<mp>/test/` | Tidak ada; fixture | `pnpm test:contract` dan job harian sandbox |
| Beban | `tools/load/*.js` (k6) | Staging | `pnpm load:run` |

### 13.2 Perlengkapan uji

- `test/setup/global-setup.ts`: memakai server dari `TEST_PG_ADMIN_URL` dan `TEST_REDIS_URL` bila diset (mesin tanpa Docker), atau Testcontainers `postgres:17` dan `redis:7.2` bila tidak. Setiap run membuat database baru `omniseller_test_<run>`, membuat role, menjalankan migrator sebagai `omniseller_migrator`, dan menghapus database di akhir (`KEEP_TEST_DB=1` untuk menyimpan). File uji integrasi berjalan berurutan dalam satu proses.
- `test/setup/handles.ts`: `testHandles()` membuka pool `api`, `worker`, `system`, koneksi Redis, dan `raw(role)` untuk memeriksa hak akses di luar `withTenantTx`; semuanya ditutup otomatis di akhir file.
- `test/setup/factories.ts`: `userCtx()`, `createTenant()`, `createWarehouse()`, `createProductWithVariant()`, `createStore()`, `createOrder()`, `applyMovement()`. Semua berjalan sebagai `omniseller_api` di dalam `withTenantTx`, sehingga factory sendiri membuktikan jalur normal lolos RLS. Factory lain (`createUser`, `createListing`) ditambahkan bersama modulnya.
- `test/setup/app.ts`: `startApi(infra)` menjalankan aplikasi api penuh (guard, pipe, filter) di port acak; `startWorker(infra, system)` membangun container worker dengan email `memory`, dan `runOutbox(tenantId)` menjalankan handler job untuk baris outbox tenant itu secara langsung, tanpa relay dan tanpa menunggu. `client(app, ip)` memberi agen supertest dengan cookie dan IP sendiri; `signup()`, `uniqueEmail()`, `tokenFrom()` membantu alur e2e.
- `test/setup/mock-marketplace.ts`: server Hono yang memutar ulang fixture dan mencatat panggilan, dengan API `mock.expect('shopee', 'orders.accept', { ... })`.
- Fixture webhook nyata teranonimkan di `packages/connectors/<mp>/test/fixtures/webhooks/*.json`.

### 13.3 Aturan menulis tes

- Setiap service publik memiliki uji integrasi untuk jalur sukses dan setiap error domain yang dapat dilemparnya.
- Setiap transisi status di 7.9 memiliki uji: transisi sah lulus, transisi tidak sah ditolak trigger, efek stok benar.
- Setiap job memiliki uji handler yang memanggil `handler(payload, helpers)` langsung, dengan connector di-mock.
- Uji isolasi tenant dibuat otomatis dari dokumen OpenAPI. Setiap operasi wajib membawa `x-isolation`: `public` (tanpa sesi), `self` (hanya data pemanggil), `global` (katalog bersama seperti daftar izin), atau `{ fixture: <jenis> }`. Untuk jenis fixture, uji membuat sumber daya di tenant A lalu memanggil sebagai Owner tenant B: operasi dengan `{id}` harus 404, daftar tidak boleh memuat id milik A, pembuatan tidak boleh menyentuh A (404, 412, atau 422), dan data A diperiksa utuh di akhir. Operasi tanpa `x-isolation`, jenis fixture tanpa pembuat, atau operasi tulis tanpa contoh body di `BODIES` menggagalkan uji.
- Uji tidak memakai `sleep`. Pekerjaan asinkron diuji dengan memanggil relay dan handler secara eksplisit.
- Data pribadi di fixture selalu palsu (nama dan nomor telepon buatan).

---

## 14. Observabilitas dan Keamanan di Kode

### 14.1 Logging

- `import { logger } from "@omniseller/logging"`; `console.*` dilarang lint.
- Field wajib otomatis: `ts`, `level`, `msg`, `request_id`, `trace_id`, `tenant_id`, `actor`, `module`.
- Redaksi otomatis untuk kunci `buyer_name`, `buyer_phone`, `shipping_address`, `email`, `password`, `token`, `authorization`, `*_enc`, `*_hash`.
- Tingkat: `info` untuk peristiwa bisnis (`order.created`), `warn` untuk kondisi yang pulih sendiri (retry), `error` untuk yang butuh tindakan.

### 14.2 Trace dan metrik

- Setiap handler job membuka span `job.<antrean>.<nama>` dengan atribut `tenant_id`, `store_id`, `job_id`.
- Setiap panggilan connector membuka span `mp.<channel>.<metode>` dengan atribut `store_id`, `http.status_code`, `mp.error_code`.
- Metrik bernama `omniseller_<subjek>_<satuan>`: `omniseller_webhook_to_order_seconds` (histogram), `omniseller_stock_push_seconds`, `omniseller_stock_push_total{result}`, `omniseller_mp_call_total{channel,method,result}`, `omniseller_queue_depth{queue}`, `omniseller_outbox_unpublished`, `omniseller_partition_default_rows{table}`, `omniseller_ai_tokens_total{route,kind}`.

### 14.3 Keamanan di kode

- Semua input melewati Zod di controller dan di batas job (payload).
- Tidak ada SQL dari string. `sql` tag Drizzle hanya dengan parameter terikat; lint menolak interpolasi template di dalam `sql`.
- `CredentialService`, `KmsService`, dan `PiiScrubber` berada di `common/security`. Modul lain tidak memanggil KMS langsung.
- Unggahan diperiksa `file-type` dari isi, dibatasi ukuran, disimpan dengan nama acak di R2, dan dicatat di `file_object`.
- Endpoint admin internal (`/internal/*`) hanya dapat diakses dari jaringan internal (SG) dan izin `admin:internal`.

---

## 15. Panduan Pengembangan Langkah demi Langkah

### 15.1 Prasyarat

| Alat | Versi | Cek |
|---|---|---|
| Node.js | 24 LTS | `node -v` |
| pnpm | 10 | `corepack enable && pnpm -v` |
| Docker dan Docker Compose | Terbaru | `docker compose version` |
| Git | Terbaru | |
| AWS CLI dan SSM plugin | Untuk staging dan produksi saja | |

### 15.2 Menyiapkan lingkungan lokal

```bash
git clone git@github.com:<org>/omniseller.git && cd omniseller
pnpm install --frozen-lockfile
cd backend
cp .env.example .env.local                        # isi nilai lokal seperlunya
pnpm infra:up                                     # docker compose: postgres (5433), redis x2
# atau tanpa Docker: pnpm infra:native start      # PostgreSQL 15+ dan Redis terpasang, port yang sama
pnpm db:bootstrap                                 # role basis data dan database omniseller
pnpm db:migrate                                   # migrasi, fungsi, trigger, RLS, grant, seed, partisi
pnpm test:schema                                  # memastikan skema sesuai konvensi
```

`pnpm db:seed:demo` (tenant demo, 2 toko, 300 SKU, 500 pesanan) menyusul bersama modul katalog dan pesanan.

### 15.3 Menjalankan proses

```bash
pnpm dev:api          # http://localhost:3000, dokumentasi di /docs
pnpm dev:webhook      # http://localhost:3001/webhooks/*
pnpm dev:worker
pnpm dev:scheduler
pnpm dev              # keempatnya sekaligus lewat tools/dev.mjs, log berwarna per proses
pnpm mock:webhook shopee order_created --store <store_id>   # kirim fixture webhook ke proses webhook lokal
```

### 15.4 Menambah modul baru

1. Buat folder `src/modules/<nama>/` dengan bentuk di bagian 4.
2. Tulis `README.md` modul dari templat 17.11: tanggung jawab, tabel yang dimiliki, event, endpoint, job. README ditulis sebelum kode.
3. Tambahkan skema tabel di `src/db/schema/<domain>.ts` mengikuti 7.2 sampai 7.7 dan langkah 15.5.
4. Tambahkan izin baru ke `packages/shared/src/permissions.ts` dan seed `permission`.
5. Tulis `<nama>.errors.ts` untuk error domain yang dapat dilempar modul.
6. Tulis `<nama>.events.ts`: nama event dan skema payload Zod.
7. Tulis repository: hanya query, menerima `tx`.
8. Tulis service: aturan bisnis, `withTenantTx`, `outbox.enqueue`, uji unit dan integrasi.
9. Tulis DTO Zod di `dto/` dan controller dengan `@RequirePermission`. Tambahkan dekorator OpenAPI.
10. Tambahkan job di `<nama>.jobs.ts` bila ada pekerjaan asinkron dan daftarkan di `jobs/registry.ts`.
11. Daftarkan modul di `app.module.ts` pada peran proses yang tepat (`api`, `worker`, atau keduanya).
12. Beri setiap endpoint `@Isolation(...)` atau `@Public()`, tambahkan fixture dan contoh body di `test/tenant-isolation` bila perlu, jalankan `pnpm test:isolation` lalu `pnpm openapi:emit`. Tambahkan controller baru ke `src/common/http/dto-metadata.spec.ts`.
13. Perbarui bagian 11 dokumen ini (peta modul) di PR yang sama.

### 15.5 Menambah tabel atau kolom

1. Tulis tabel di migrasi berversi baru (`drizzle/migrations/NNNN_add_<tabel>.sql`) dengan kolom standar 7.2, domain `ulid`, dan FK komposit 7.3.
2. Tentukan `ON DELETE` setiap FK menurut 7.4 dan tulis alasannya di komentar SQL; `SET NULL` selalu dengan daftar kolom.
3. Tambahkan `CHECK` untuk setiap domain nilai (status, jumlah, rentang) dan `UNIQUE` untuk setiap identitas bisnis.
4. Bila tabel berstatus: buat tabel `<tabel>_status_transition` (dengan kolom `via`) di migrasi, seed transisinya di `90_seeds.sql`, pasang trigger `enforce_status_transition('<tabel>')` di `20_triggers.sql`, dan tambahkan ke 7.9.
5. Bila tabel besar: `PARTITION BY RANGE (id)` dengan partisi `DEFAULT`, dan tambahkan ke `partition_targets()` (7.6).
6. Bila tabel sensitif: pasang trigger `audit_row` di `20_triggers.sql`. Bila butuh hak lebih sempit dari CRUD baku: tambahkan pengecualian di `40_grants.sql`.
7. Tulis cermin Drizzle di `src/db/schema/<domain>.ts` dengan `baseColumns()`, `ulid()`, `money()`.
8. `pnpm db:migrate && pnpm test:schema`.
9. Tambahkan factory di `test/setup/factories.ts`.
10. Perbarui 7.8 dokumen ini.

### 15.6 Menambah endpoint

1. Tentukan izin dan cakupan (toko atau gudang) yang diperlukan.
2. Tulis skema DTO request dan response di `dto/`.
3. Tambahkan metode controller dengan `@RequirePermission`, `@ApiOperation`, dan `Idempotency-Key` bila memicu efek luar.
4. Implementasikan di service; controller hanya memetakan DTO ke pemanggilan service.
5. Tambahkan uji e2e untuk 200, 401, 403, 404 lintas tenant, 422.
6. `@Isolation(...)`, `@ZodResponse(...)`, `pnpm test:isolation`, `pnpm openapi:emit`, lalu `pnpm openapi:client` bila klien sudah ada. DTO diimpor sebagai nilai, bukan `import type` (lihat `AGENTS.md`).
7. Bila mengubah kontrak yang sudah ada: pastikan `oasdiff` tidak melaporkan perubahan yang memutus, atau naikkan versi.

### 15.7 Menambah job atau jadwal

1. Tambahkan definisi di `src/modules/<modul>/<modul>.jobs.ts` dengan `defineJob` (9.1): antrean, skema payload, `jobId` deterministik dari `jobKey()` (sekali per entitas atau per kejadian, 9.2), opsi retry.
2. Handler memanggil service, bukan repository. Pastikan idempoten dengan memeriksa keadaan.
3. Daftarkan di `jobs/registry.ts`. Bila berulang, tambahkan ke `scheduler/schedules.ts` dengan zona `Asia/Jakarta` dan role basis data yang benar.
4. Tulis uji handler dengan connector di-mock dan uji `jobId` untuk payload yang sama menghasilkan kunci sama.
5. Tambahkan metrik dan span sesuai 14.2.
6. Perbarui 9.2 dan 9.5 dokumen ini.

### 15.8 Menambah connector marketplace

1. Buat paket `packages/connectors/<marketplace>/` dari templat `packages/connectors/_template`.
2. Implementasikan `MarketplaceConnector` (DOKUMEN-TEKNOLOGI 26.4). Metode yang tidak didukung dibiarkan `undefined`.
3. Tulis pemetaan status pesanan ke `order.status` di `status-map.ts` dan seed `connector_status_map`.
4. Deklarasikan batas laju dan masa hidup token di `manifest.ts`.
5. Rekam fixture respons nyata dari sandbox, anonimkan, simpan di `test/fixtures/`. Tulis uji kontrak untuk setiap metode.
6. Tambahkan verifikasi tanda tangan webhook dan parser event ke `webhooks.ts`; tambahkan route di `webhook.controller.ts`.
7. Daftarkan di `ConnectorRegistry` dan tambahkan nilai `channel` ke CHECK `store.channel` lewat migrasi.
8. Jalankan `pnpm test:contract` dan uji e2e alur pesanan dengan server tiruan yang diperluas untuk marketplace baru.
9. Perbarui DOKUMEN-TEKNOLOGI 8.1 dan PRD 11.1.

### 15.9 Menambah event dan consumer

1. Definisikan nama dan skema payload di `<modul>.events.ts` pemilik agregat.
2. Terbitkan lewat `outbox.enqueue(tx, ...)` di service pemilik, dalam transaksi yang sama dengan perubahan data.
3. Buat job consumer di modul yang berkepentingan (15.7). Satu event boleh punya banyak consumer; masing-masing job terpisah dengan `jobId` sendiri.
4. Uji: terbitkan event di uji integrasi, jalankan relay, pastikan job masuk antrean dengan `jobId` yang diharapkan.
5. Perbarui kolom event di bagian 11.

### 15.10 Menulis dan menjalankan tes

```bash
pnpm test                 # unit, cepat
pnpm test:int             # integrasi (Testcontainers)
pnpm test:schema          # konvensi skema
pnpm test:isolation       # isolasi tenant dari OpenAPI
pnpm test:e2e             # API end-to-end
pnpm test:contract        # connector terhadap fixture
pnpm test:all             # semuanya, sama dengan CI
```

### 15.11 Checklist pull request

- [ ] Judul mengikuti Conventional Commits, deskripsi menyebut bagian PRD yang dipenuhi.
- [ ] Semua invarian di 2.2 dipatuhi.
- [ ] Tes ditambahkan sesuai 13.3; `pnpm test:all` hijau.
- [ ] Migrasi (bila ada) memenuhi checklist 12.3 dan `EXPLAIN ANALYZE` dilampirkan untuk query baru pada tabel besar.
- [ ] `openapi.json` diperbarui dan `oasdiff` tidak melaporkan perubahan yang memutus.
- [ ] README modul dan bagian terkait dokumen ini diperbarui.
- [ ] Tidak ada rahasia, tidak ada `console.*`, tidak ada data pribadi di fixture.
- [ ] Fitur berisiko di balik feature flag.
- [ ] Satu peninjau menyetujui; tech lead untuk perubahan skema, auth, stok, atau connector.

### 15.12 Rilis

1. Merge ke `main` memicu build dan deploy staging otomatis, lalu e2e dan uji kontrak sandbox.
2. Buat tag `vX.Y.Z` dengan `pnpm release` (menghasilkan catatan rilis dari commit).
3. Persetujuan manual di GitHub Actions; migrasi produksi berjalan sebagai tugas ECS; CodeDeploy blue/green 10% selama 10 menit lalu 100%.
4. Aktifkan feature flag bertahap dari UI admin internal: 5% tenant, 25%, 100%, dengan jeda minimal 24 jam.
5. Pantau dasbor rilis (error rate, p95, DLQ, `outbox_unpublished`) selama 1 jam.

---

## 16. Runbook Operasional

| Gejala | Langkah |
|---|---|
| Pesanan tidak masuk dari satu marketplace | 1) Cek halaman status dan `omniseller_mp_call_total{result=error}` untuk marketplace itu. 2) Cek `webhook_inbox` 15 menit terakhir: bila ada baris `processed_at IS NULL` dengan `last_error`, lihat error. 3) Bila tidak ada baris masuk sama sekali, verifikasi URL webhook di partner center dan `signature_valid`. 4) Polling cadangan seharusnya menutup celah dalam 5 menit; cek `sync_job kind='orders.list'`. 5) Untuk memutar ulang: `pnpm ops:webhook:replay --source shopee --since 2026-09-30T00:00Z` |
| Stok di marketplace tidak sesuai OmniSeller | 1) Cek `store.sync_mode` (harus `live`) dan `channel_warehouse.mapping_status`. 2) Cek `listing_stock_state` untuk listing itu: `last_error`, `push_fail_count`. 3) Cek `stock:dirty` di Redis dan panjang antrean `stock.push`. 4) Paksa push: `pnpm ops:stock:push --variant <id> --warehouse <id>`. 5) Bila marketplace menampilkan nilai yang tidak pernah dikirim OmniSeller, curigai aplikasi lain masih terotorisasi (FR-MIG-07) |
| DLQ membesar | 1) `pnpm jobs:dlq --queue <nama>` untuk melihat error terbanyak. 2) Bila penyebabnya marketplace (5xx, 429), tunggu pulih lalu `pnpm jobs:retry --queue <nama> --all`. 3) Bila bug, perbaiki, deploy, lalu ulang. 4) Jangan buang job pesanan tanpa membuat `order_problem` |
| Toko `reauth_required` | 1) Cek `store_credential.refresh_fail_count` dan `sync_job kind='auth.refresh'`. 2) Bila token dicabut seller, pengguna harus otorisasi ulang dari UI; tidak ada jalan pintas. 3) Setelah otorisasi ulang, `store.initial_import` tidak dijalankan ulang; polling menutup celah |
| Partisi `DEFAULT` berisi baris | 1) Alarm `omniseller_partition_default_rows`. 2) Jalankan `pnpm ops:partition:maintain` untuk membuat partisi yang hilang. 3) Pindahkan baris: skrip `tools/scripts/repartition.ts` memindahkan dari `DEFAULT` ke partisi benar dalam batch |
| Perlu memutar ulang satu webhook | `pnpm ops:webhook:replay --id <webhook_inbox.id>` mengenqueue ulang `order.ingest` dengan `jobId` yang sama; bila job lama masih tercatat selesai, tambahkan `--force` yang menambahkan suffix waktu |
| Rollback rilis | 1) CodeDeploy: pilih revisi sebelumnya, atau otomatis oleh alarm. 2) Matikan feature flag terkait. 3) Migrasi tidak dibalik (expand and contract); bila migrasi menyebabkan masalah, tulis migrasi perbaikan |
| Rotasi DEK tenant | `pnpm ops:crypto:rotate-dek --tenant <id>` mendekripsi dan mengenkripsi ulang semua `*_enc` tenant itu dalam batch, menaikkan `dek_version`; hanya dari proses `worker` |
| Hapus tenant (permintaan resmi) | 1) `tenant.status = 'closing'` (baca saja 30 hari). 2) Ekspor penuh dan kirim ke owner. 3) `pnpm ops:tenant:purge --tenant <id> --confirm <slug>` dengan role `omniseller_system`, urutan dependensi dari `information_schema`, `app.stock_write` diaktifkan, `audit_log` diekspor sebelum dihapus |
| Basis data lambat | 1) `pg_stat_statements` 10 query teratas. 2) Cek partisi: query tanpa filter `id` pada tabel terpartisi memindai semua partisi. 3) Cek `idle in transaction`. 4) Bila laporan, pindahkan ke read replica |

---

## 17. Lampiran Kode dan Berkas

Versi 1.0 dokumen ini memuat cuplikan kode sebagai rancangan. Sejak fondasi diimplementasikan, kode di repositori adalah sumber kebenaran; cuplikan yang diduplikasi di dokumen pasti melenceng. Tabel berikut menunjuk ke berkasnya.

| Bagian lama | Berkas | Isi |
|---|---|---|
| 17.1 | `packages/shared/src/ulid.ts` | `newId()`, `ulidSchema`, `assertUlid`, `ulidTime`, `ulidLowerBound` |
| 17.2 | `src/db/columns.ts`, `drizzle/migrations/0001_core.sql` | Kolom standar dan tipe `ulid` untuk cermin Drizzle; DDL dengan FK komposit (menggantikan helper `tenantFk()`, ADR-027) |
| 17.3 | `src/db/tenant-tx.ts` | `withTenantTx`, `withSystemTx`, `withStatusSource` |
| 17.4 | `drizzle/sql/10_functions.sql` | `touch_row`, `enforce_status_transition`, `inventory_guard`, `ensure_inventory`, `apply_stock_movement`, `audit_row`, `audit_log_immutable`, `outbox_notify`, lookup pra-tenant, `gen_ulid`, fungsi partisi |
| 17.4 (lanjutan) | `drizzle/sql/20_triggers.sql`, `30_policies.sql`, `40_grants.sql`, `90_seeds.sql` | Pemasangan trigger, kebijakan RLS, hak per role, seed |
| 17.5 | `partition_targets()` dan `maintain_partitions()` di `10_functions.sql`; `src/scheduler/scheduler.runner.ts` | Partisi dibuat di SQL (butuh hak pemilik tabel); scheduler memanggilnya |
| 17.6 | `src/scheduler/outbox-relay.ts`, `src/outbox/outbox.ts` | Relay dan penulisan outbox |
| 17.7 | `infra/docker/compose.local.yml`, `tools/scripts/native-infra.sh` | Layanan lokal dengan dan tanpa Docker |
| 17.8 | `src/common/errors/` | Hierarki error, `toProblem`, `ProblemDetailsFilter` |
| (baru) | `src/jobs/` | `defineEvent`, `defineJob`, `jobKey`, `JobRegistry`, `QueueRegistry`, `StockDirtySet` |
| (baru) | `src/db/migrate.ts`, `src/db/bootstrap.ts` | Migrator (12.1) dan pembuatan role |
| (baru) | `test/` | Uji integrasi invarian (13) |

### 17.9 Skrip pnpm (root `package.json`)

| Skrip | Fungsi | Status |
|---|---|---|
| `pnpm dev`, `pnpm dev:api`, `pnpm dev:webhook`, `pnpm dev:worker`, `pnpm dev:scheduler` | Menjalankan proses lokal (`tsc --watch` dan `node --watch` per peran, `tools/dev.mjs`) | Ada |
| `pnpm infra:up`, `pnpm infra:down`, `pnpm infra:reset` | Docker Compose lokal | Ada |
| `pnpm infra:native start\|stop\|status` | Layanan lokal tanpa Docker | Ada |
| `pnpm db:bootstrap`, `pnpm db:migrate` | Role dan database; migrasi (12.1) | Ada |
| `pnpm db:seed:demo`, `pnpm db:reset` | Data demo; reset basis data lokal | Menyusul |
| `pnpm test`, `test:int`, `test:schema`, `test:all` | Pengujian | Ada |
| `pnpm test:isolation` | Isolasi tenant dari OpenAPI | Ada |
| `pnpm test:e2e`, `test:contract` | e2e API (saat ini bagian dari `test:int`), kontrak connector | Menyusul bersama connector |
| `pnpm lint`, `pnpm typecheck`, `pnpm format` | Biome dan tsc | Ada |
| `pnpm openapi:emit` | Menulis `openapi.json` | Ada |
| `pnpm openapi:client`, `pnpm openapi:diff` | Klien TypeScript untuk frontend, pemeriksaan perubahan pemutus | Menyusul bersama frontend dan CI |
| `pnpm jobs:dlq --queue`, `pnpm jobs:retry --queue --id <id>` atau `--all` | Antrean | Menyusul |
| `pnpm ops:webhook:replay`, `ops:stock:push`, `ops:partition:maintain`, `ops:crypto:rotate-dek`, `ops:tenant:purge` | Operasional (memerlukan `OPS_CONFIRM=1` di produksi) | Menyusul |
| `pnpm mock:webhook <channel> <event> --store <id>` | Kirim fixture ke proses webhook lokal | Menyusul |
| `pnpm release` | Tag dan catatan rilis | Menyusul |

### 17.10 `AGENTS.md` (root repositori)

Berkas `AGENTS.md` di root repositori adalah versi yang berlaku (invarian, perintah, tempat berkas, cara menambah, definisi selesai).

### 17.11 Templat README modul

```markdown
# Modul <nama>

## Tanggung jawab
Satu paragraf.

## Tabel yang dimiliki
- `<tabel>`: ...

## Service publik
- `<Nama>Service.<metode>(ctx, ...)`: kapan dipakai, error yang dilempar.

## Event
- Diterbitkan: `<agregat>.<...>` (skema di `<nama>.events.ts`)
- Dikonsumsi: ...

## Endpoint
| Metode | Path | Izin |

## Job
| Antrean | Nama | jobId |

## Keputusan khusus modul
Tautan ke ADR bila ada.
```

### 17.12 `.env.example`

Berkas `.env.example` adalah versi yang berlaku. Kunci dikelompokkan per peran proses (5.2); URL basis data per role memakai port lokal 5433.

---

## 18. Glosarium dan Riwayat

| Istilah | Arti |
|---|---|
| ULID | Universally Unique Lexicographically Sortable Identifier, id 26 karakter terurut waktu |
| RLS | Row-Level Security, kebijakan baris di PostgreSQL |
| FK komposit tenant | Kunci asing `(tenant_id, x_id)` yang mencegah relasi lintas tenant |
| Outbox | Tabel event yang ditulis dalam transaksi bisnis dan dipublikasikan relay ke antrean |
| Expand and contract | Pola migrasi: tambah dulu, pindahkan pembaca, hapus kemudian |
| Partisi range ULID | Partisi tabel berdasarkan rentang `id` yang mewakili rentang waktu |
| `withTenantTx` | Helper transaksi yang menetapkan tenant untuk RLS |
| `apply_stock_movement` | Fungsi SQL tunggal untuk mengubah stok |
| Mesin status | Daftar transisi sah yang dijaga trigger |
| DLQ | Dead letter queue, antrean job yang gagal setelah semua percobaan |

| Versi | Tanggal | Perubahan | Penulis |
|---|---|---|---|
| 1.0 | 30 September 2026 | Dokumen awal: kontrak agen, struktur proyek, lingkungan, ULID, skema lengkap dengan relasi dan batasan, mesin status, lapisan aplikasi, job, API, peta modul, migrasi, pengujian, langkah pengembangan, runbook, lampiran kode | Candra Syahputra |
| 1.1 | 30 September 2026 | Implementasi fondasi dan perbaikan desain yang ditemukan saat implementasi, masing-masing dengan uji: (1) `jobId` memakai pemisah `\|` karena BullMQ menolak `:`, dan aksi berulang memakai id per kejadian agar dorongan stok atau harga kedua tidak dibuang (9.2, 9.4); (2) trigger status menerima nama tabel sebagai argumen karena `TG_TABLE_NAME` berisi nama partisi (7.7); (3) `ON DELETE SET NULL (kolom)` pada FK komposit (7.4); (4) fungsi `SECURITY DEFINER` untuk menemukan tenant dari webhook, login, token, dan undangan (7.5); (5) transisi status via `marketplace` untuk mode paralel dan alur tanpa scan (7.9); (6) id audit dibuat di basis data (7.7); (7) penukaran kode OAuth dan enkripsi token di worker, `api` tanpa akses token dan KMS (8.6); (8) refresh token dikunci per toko (8.6); (9) jumlah stok hanya lewat fungsi karena role aplikasi tidak punya hak tulis, `buffer` masuk ledger (7.8.4). Perubahan lain: domain `ulid` di atas `text`, migrasi SQL tulisan tangan dengan migrator sendiri (12, ADR-027), partisi `sync_job` bulanan, env per peran, layanan lokal tanpa Docker, lampiran kode diganti penunjuk ke berkas | Candra Syahputra |
| 1.2 | 30 September 2026 | Kode backend dipindah ke folder `backend/` (ADR-032): semua path di dokumen ini relatif terhadap `backend/`; struktur bagian 4 dan langkah 15.2 disesuaikan; runner dev tanpa Turborepo | Candra Syahputra |
| 1.3 | 1 Oktober 2026 | Identitas, autentikasi, dan audit diimplementasikan: urutan 8.1 disesuaikan dengan urutan NestJS (guard sebelum pipe; `AuthGuard` menggabungkan sesi, status tenant, dan batas laju; cakupan diperiksa di service); 8.10 baru (sesi Redis, Argon2id, penguncian tanpa oracle, batas laju, token dibuat di worker); `invitation` mendapat `sent_at`, `revoked_at`, token nullable, dan satu undangan terbuka per email; tabel `password_reset_token` dan fungsi `auth_resolve_password_reset` (migrasi 0002); env email dan `PUBLIC_WEB_URL` (5.2), Mailpit (5.4); daftar endpoint 10.6; uji isolasi tenant memakai `x-isolation` (13.3); job didefinisikan di modul (9.1) | Candra Syahputra |
