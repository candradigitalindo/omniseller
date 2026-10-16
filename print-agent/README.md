# Agen cetak OmniSeller (M51)

Aplikasi Electron untuk Windows 10/11 x64 (utama) dan macOS Apple Silicon. Jendela 420 × 560 dapat ditutup ke tray; pilih **Keluar** untuk menghentikannya. Berkomunikasi hanya lewat kontrak HTTP/Socket.IO backend; tidak mengimpor modul backend.

## Menjalankan

Node.js 24 dan pnpm 10, perintah dari `print-agent/`:

```sh
pnpm install --frozen-lockfile
pnpm vendor                 # Windows: SumatraPDF 3.6.1 dengan SHA-256 terkunci
pnpm dev
pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e                # Electron sungguhan, printer dan backend tiruan; tidak mencetak kertas
```

Di web app, Pengaturan → Agen cetak, tambahkan komputer lalu salin token sekali tampil. Tempel origin API (contoh `https://api.omniseller.id`) dan token ke aplikasi. Mode pengembangan menerima HTTP **hanya di loopback** (`http://127.0.0.1:3000`); paket installer selalu membutuhkan HTTPS. Pilih printer label thermal dan dokumen A4, simpan, lalu **Cetak percobaan**. Ukuran kertas dikonfigurasi pada driver printer: label 100 × 150 mm, dokumen A4; aplikasi mencetak pada skala asli, tanpa dialog.

Nama komputer serta printer bawaan disimpan kembali di backend. Heartbeat tidak menimpa perubahan pengaturan dari web. Menjeda menghentikan pengiriman baru ke printer, sementara laporan hasil yang sudah tercetak tetap dikirim. **Lepas pasangan** menghapus token lokal; pencabutan token di semua salinannya dilakukan dari web app.

## Antrean dan pemulihan

- Socket.IO memakai WebSocket dan `auth.token`. Push hanya petunjuk; saat tersambung kembali dan setiap menit agen mengambil paling banyak 50 pekerjaan melalui REST. Setelah satu kelompok dicetak, agen mengambil kelompok berikutnya.
- SQLite (`node:sqlite`, WAL, `synchronous=FULL`) mengunci satu pekerjaan per `(origin API, id perangkat, id pekerjaan, attempt)`. Duplikat push/poll tidak mencetak ulang. Nomor `attempt` dari backend tetap sama saat berkas diambil berulang, lalu bertambah untuk **Cetak ulang** di web. Laporan dari percobaan lama ditolak 409.
- Jurnal ditulis `printing` **sebelum** memanggil spooler. Sesudah restart, pekerjaan yang tertinggal di sana menjadi **Periksa hasil**. Periksa kertas, pilih **Sudah tercetak**, atau nyatakan gagal lalu gunakan **Cetak ulang**. Agen tidak mengulang pekerjaan ini otomatis.
- `printed` berarti sistem operasi menerima pekerjaan cetak. Kertas benar-benar keluar tidak dapat dijamin API spooler. Gangguan saat memanggil driver juga memerlukan pemeriksaan hasil; ini menghindari cetak ganda akibat jawaban spooler yang hilang.
- Hilang koneksi: antrean dipertahankan, retry dengan backoff 2–60 detik. Printer hilang/sibuk sebelum pemanggilan spooler: paling banyak 5 percobaan. Hasil yang belum terkirim dicoba lagi tanpa mencetak ulang. Token dicabut menghentikan unduhan/cetak berikutnya.
- Jurnal hanya menyimpan id, nomor percobaan, jenis, nama printer, jumlah salinan, waktu, status, dan kode kegagalan. Judul, data pembeli, token, URL berkas, serta isi PDF tidak masuk jurnal. Riwayat yang sudah dilaporkan dibersihkan setelah 7 hari; layar menampilkan 50 entri terbaru.

## Batas keamanan

Renderer tersandbox, `contextIsolation`, tanpa Node; IPC sempit dengan validasi payload dan frame pemanggil. Aset lokal lewat `app://agent`, CSP menolak jaringan dari renderer, navigasi/jendela baru/izin perangkat ditolak. Semua teks UI berasal dari `messages/id.json` (template HTML diisi ketika build).

Token dan identitas pasangan dienkripsi `safeStorage` OS di `credentials.enc`; tidak ada fallback plaintext. SQLite dan PDF sementara berada dalam direktori data aplikasi. PDF diunduh secara streaming (batas 50 MB, timeout 30 detik, awalan `%PDF-`), nama acak, izin 0600; token Bearer tidak diteruskan ke redirect penyimpanan. PDF dibuang setelah berhasil/gagal, dan sisa PDF akibat crash dibersihkan saat start. Aplikasi tidak mencatat data pesanan atau URL bertanda tangan. Data aplikasi berada di lokasi `app.getPath("userData")` untuk **OmniSeller Agen Cetak**.

Windows memakai `pdf-to-printer` dengan executable SumatraPDF 3.6.1 yang terpisah; executable lama bawaan npm tidak dimasukkan installer. `resources/sumatra/lock.json` mengunci URL dan checksum, dan paket menyertakan lisensi/atribusi upstream. macOS memakai `/usr/bin/lp` dengan argumen langsung (tanpa shell). Printer bawaan diperoleh dari OS, tidak ditebak dari urutan printer.

## Installer dan pembaruan

```sh
pnpm pack                   # folder aplikasi untuk pemeriksaan lokal
pnpm dist:win               # NSIS x64 (Windows; dapat dibangun dari macOS)
pnpm dist:mac               # DMG arm64
```

Hasil di `release/`, tidak dikomit. Build Windows menaruh source SumatraPDF yang checksum-nya dikunci di sebelah installer; distribusikan keduanya bersama. Konfigurasi default membuat paket internal unsigned tanpa feed pembaruan. Untuk rilis publik gunakan `pnpm release` di masing-masing OS: konfigurasi rilis mewajibkan code signing, notarization macOS, dan feed HTTPS. Skrip **tidak mengunggah/publish** apa pun. Sediakan:

- Windows: `WIN_PUBLISHER_NAME`, `CSC_LINK`, `CSC_KEY_PASSWORD`.
- macOS: `MAC_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; sertifikat Developer ID tersedia di Keychain.
- Keduanya: `PRINT_AGENT_UPDATE_URL`, origin/direktori feed HTTPS. Publikasikan installer, ZIP pembaruan macOS (wajib untuk updater, dibuat oleh konfigurasi rilis), blockmap, `latest.yml`/`latest-mac.yml`, serta source SumatraPDF yang sesuai (`resources/sumatra/NOTICE.txt`) pada lokasi distribusi yang sama. Jangan mengubah identitas penerbit antarversi.

Paket rilis memakai `electron-updater`: memeriksa dan mengunduh pembaruan saat idle setiap 4 jam (pertama pada heartbeat awal). **Periksa pembaruan** memicu pemeriksaan langsung. Pemeriksaan/unduhan ditolak saat antrean masih berjalan. Instalasi pembaruan yang telah diunduh dilakukan ketika aplikasi keluar setelah pekerjaan aktif selesai. Paket internal tidak mencoba mengakses feed.

## Struktur dan kontrak

`src/core/`: klien API, SQLite, mesin antrean; `src/platform/`: token OS dan driver; `src/application.ts`: lifecycle/tray/IPC/realtime/updater; `src/preload.ts`: bridge; `src/renderer/`: tampilan lokal. `test/electron-main.ts` hanya entry pengujian dengan printer dan penyimpanan rahasia tiruan; tidak pernah masuk `dist/` atau paket aplikasi.

Setelah kontrak berubah: `pnpm openapi:emit` dari `backend/`, lalu `pnpm api:types` di `frontend/` **dan** `print-agent/`. `src/api/schema.d.ts` dihasilkan otomatis, jangan diedit. CI memeriksa lint, tipe, unit, Electron pada Windows/macOS, build installer, dan perbedaan hasil generasi kontrak.

Uji fisik sebelum distribusi: cetak percobaan pada thermal 100 × 150 dan A4, barcode bisa dipindai, orientasi/skala benar, cabut kabel/habiskan kertas, restart saat job berjalan, dan pastikan konfirmasi **Periksa hasil** sesuai keluaran. Tes otomatis menggunakan spooler tiruan dan tidak membuktikan kompatibilitas model printer tertentu.
