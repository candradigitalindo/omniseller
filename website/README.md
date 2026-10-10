# Situs publik OmniSeller

Halaman publik untuk calon pelanggan dan untuk pemeriksaan pihak ketiga (pendaftaran Xendit, review partner marketplace): beranda dengan fitur, harga, kontak dan layanan pengaduan, Syarat Layanan, Kebijakan Privasi, dan Kebijakan Pengembalian Dana. Hasilnya berkas HTML statis di `dist/`, tanpa JavaScript, cookie, font, atau pelacak dari luar, jadi bisa di-host gratis dan terbit sebelum web app berjalan (DOKUMEN-TEKNOLOGI ADR-041).

## Isi

```
site.json           semua data bisnis: nama badan usaha, alamat, NIB, NPWP, kontak, harga, angka kebijakan
build.mjs           membangun dist/ dari src/ dan site.json (Node 22 atau lebih baru, tanpa dependensi)
serve.mjs           pratinjau dist/ di http://127.0.0.1:4173
src/pages/          satu modul per halaman (beranda, harga, kontak, tiga kebijakan, 404)
src/layout.mjs      kepala halaman, menu, dan kaki halaman bersama
src/assets/         style.css (warna web app, terang dan gelap) dan favicon.svg
test/               uji (node:test) dan contoh site.json yang sudah terisi
```

## Mengisi dan membangun

1. Isi setiap `[ISI: ...]` di `site.json`. `node build.mjs` menampilkan yang masih kosong; `node build.mjs --strict` gagal selama masih ada, jadi situs yang belum lengkap tidak pernah terbit.
2. `node build.mjs --strict` menulis `dist/`.
3. Pratinjau: `node serve.mjs`, lalu buka http://127.0.0.1:4173. Untuk melihat tampilan sebelum data asli siap: `pnpm preview` (memakai `test/filled-site.json`, data contoh).
4. Uji: `node --test "test/*.test.mjs"` (juga dijalankan CI).

## Menerbitkan gratis

Unggah isi folder `dist/` ke salah satu:

- **Cloudflare Pages:** dasbor Cloudflare > Workers & Pages > Create > Pages > Upload assets, seret folder `dist`. Alamatnya `https://<nama-proyek>.pages.dev`; domain sendiri bisa dipasang di Custom domains.
- **Netlify Drop:** buka https://app.netlify.com/drop dan seret folder `dist`. Alamatnya `https://<nama>.netlify.app`.

Halaman `404.html` dipakai kedua layanan itu untuk alamat yang tidak ada. Setelah mengubah `site.json` atau isi halaman, bangun ulang lalu unggah lagi.

Domain sendiri (misalnya `omniseller.id`) lebih meyakinkan untuk pemeriksaan pembayaran daripada subdomain gratis. Isi `url` di `site.json` dengan alamat akhir sebelum membangun, karena alamat itu dipakai di `sitemap.xml` dan tautan kanonis.

## Untuk pendaftaran Xendit

Isi kolom website dengan alamat situs ini. Saat aktivasi akun Live, Xendit memeriksa bahwa situs aktif dan bisa diakses, sesuai jenis usaha, dan menampilkan produk beserta harganya. Halaman Harga, Kontak, dan ketiga kebijakan di situs ini menjawab itu. Mode uji Xendit tidak menunggu aktivasi.

## Sebelum terbit

- Semua `[ISI: ...]` terisi dengan data badan usaha yang sebenarnya.
- Ketiga kebijakan ditinjau konsultan hukum (PRD 12.7). Angka di `site.json` bagian `legal` (batas pengajuan dan waktu proses pengembalian dana, penghapusan data setelah akun ditutup) adalah usulan yang harus Anda setujui.
- Harga, kuota, dan fitur tambahan paket (`extras`) sama dengan seed backend (`backend/drizzle/sql/90_seeds.sql`); `extras` hanya memuat fitur yang benar-benar dibatasi backend (`PLAN_FEATURES` di `backend/src/common/plan-features.ts`, sekarang peran kustom). Uji memeriksa keduanya. Harga Business masih usulan sampai validasi pilot (PRD 14).
- `pricing.taxNote` menyatakan perlakuan PPN yang benar untuk badan usaha Anda.
- Kebijakan Privasi menjanjikan anonimisasi data pembeli paling lama 24 bulan setelah pesanan (PRD 12.1); backend menjalankannya setiap jam (backend doc 8.34), dan penjual bisa memilih 3 sampai 24 bulan di Profil bisnis. Ubah keduanya bersama bila aturannya berubah.
- Kebijakan Privasi dan Syarat Layanan menjanjikan penghapusan data bisnis dalam 30 hari setelah akun ditutup (PRD 12.1). Penutupan akun dan penghapusan tenant belum dibuat dan harus ada sebelum rilis publik.
- Daftar sub-prosesor di Kebijakan Privasi sesuai layanan yang benar-benar dipakai saat terbit.

## Aturan menulis isi

- Hanya fitur yang sudah ada di aplikasi. Situs adalah janji; rencana tidak ditulis sebagai fitur.
- Kanal TikTok Shop disebut "Tokopedia & Shop" (aturan merek platform, PRD 5.6); kata TikTok tidak muncul. Uji memeriksanya.
- Teks literal di templat menulis `&amp;` untuk `&`; nilai dari `site.json` di-escape otomatis oleh `html`.
- Tidak ada skrip, font, atau gambar dari situs lain. Uji memeriksanya.
