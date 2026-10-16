# ADR-042 — Perintah operasional memakai daftar failed BullMQ

Tanggal: 16 Oktober 2026. Status: diterima.

## Konteks

Rancangan backend 9.6 menyebut antrean `<nama>.dlq`, tetapi implementasi menyimpan job gagal dalam daftar `failed` antrean asal (`removeOnFail` tujuh hari). M50 membutuhkan daftar dan pengulangan operasional untuk job yang sudah tersimpan, termasuk kegagalan sebelum CLI tersedia.

## Keputusan

`jobs:dlq` membaca daftar `failed` antrean asal. `jobs:retry` memakai `Job.retry("failed", {resetAttemptsMade: true, resetAttemptsStarted: true})` setelah memvalidasi nama job, skema payload, dan tenant ULID. Tidak membuat antrean DLQ baru, menyalin payload, atau menghapus job. `--all` memilih batch terbatas; job yang tidak sah tetap tersimpan. Mutasi produksi memerlukan `OPS_CONFIRM=1`; `--dry-run` tersedia.

## Konsekuensi

Job yang sudah gagal langsung dapat ditangani tanpa migrasi Redis. Daftar dan retry manual hanya menerima job yang saat itu berstatus `failed`. Metadata CLI tidak memuat payload, pesan error, hasil, atau stack trace. Job tetap mengikuti masa simpan tujuh hari dan pembersihan BullMQ saat ada aktivitas antrean. UI admin dan pembuatan `order_problem` otomatis saat percobaan habis belum diimplementasikan; CLI tidak mengklaim keduanya tersedia.
