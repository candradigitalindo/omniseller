# OmniSeller Web

Web app OmniSeller untuk penjual: Next.js 16 (App Router), React 19, Tailwind CSS 4, shadcn/ui, TanStack Query, dan klien API bertipe dari `backend/openapi.json`. Keputusan teknologinya ada di `DOKUMEN-TEKNOLOGI.md` bagian 9 dan ADR-039; spesifikasi layar di `DOKUMEN-UI-UX.md`.

Layar yang sudah ada: masuk, daftar, lupa dan atur ulang kata sandi, undangan (L49 dan sekitarnya), Ringkasan (L01), Pesanan dengan panel detail (L03, L04), Pesanan Manual Baru dengan cari atau pindai barang, pembeli, pengiriman atau ambil sendiri, dan cara bayar (L04a), Pengiriman dengan kemas dengan scan, cetak label dan daftar ambil, antrean cetak, dan serah terima kurir (L05 sampai L08), Retur & Batal dengan keputusan, foto bukti, dan penerimaan barang (L09), Produk dengan tambah manual, impor CSV, dan halaman detail (Informasi, Varian, Listing tertaut, Riwayat; L13, L14), Listing Toko dengan progres dan pemetaan SKU (L15), Salin Listing antartoko dengan antrean draf, aksi massal, pemilih kategori, dan editor draf (L15a), Stok dengan dialog Sesuaikan stok (L19), Gudang dengan pemetaan gudang marketplace (L20), Stock Opname dengan pindai, tinjau, dan terapkan (L22), Transfer Stok dari draf sampai diterima (L23), Perlu Restock dengan sisa hari dan saran pesan per gudang (L24a), Migrasi Data dengan impor produk dari aplikasi lain (unggah, pemetaan kolom, periksa, impor), uji berdampingan per toko, pindah sepenuhnya, dan pembatalan 24 jam (L46), Laporan Penjualan dengan pembanding, grafik tren, rincian per kanal, toko, produk, kategori, provinsi, dan jam, serta CSV tiap bagian (L30), Toko Terhubung dengan wizard hubungkan toko dan halaman callback otorisasi (L40), Tim & Peran dengan undangan, cakupan, dan matriks izin (L41), Printer & Label dengan pasang agen cetak dan template label (L42), Notifikasi (L44), dan Ekspor Data (L46a).

## Menjalankan

Butuh Node.js 24, pnpm 10, dan backend yang berjalan (lihat `backend/`). Semua perintah dari folder `frontend/`.

```bash
pnpm install
cp .env.example .env.local      # API_ORIGIN: alamat proses api, bawaan http://localhost:3000
pnpm dev                        # http://localhost:3100 (sama dengan PUBLIC_WEB_URL backend)
```

Web app memanggil api di origin-nya sendiri (`/v1/...`), jadi cookie sesi `os_session` ikut tanpa CORS. Di lokal Next meneruskan `/v1/*` ke `API_ORIGIN`; di produksi ALB yang meneruskannya ke api, dan web app tidak pernah tahu alamat api.

| Perintah | Isi |
|---|---|
| `pnpm dev` | Server pengembangan di port 3100 |
| `pnpm build`, `pnpm start` | Build produksi dan menjalankannya di port 3100 |
| `pnpm lint` | Biome (format, lint, urutan import) |
| `pnpm typecheck` | `next typegen` lalu `tsc --noEmit` |
| `pnpm test` | Vitest: unit dan komponen di jsdom |
| `pnpm api:types` | Menulis ulang `src/lib/api/schema.d.ts` dari `../backend/openapi.json` |

## Struktur

```
messages/id.json           semua teks antarmuka (next-intl); kuncinya dicek tipe
src/app/                   rute: (auth) masuk, daftar, sandi, undangan; (app) layar di dalam shell
src/proxy.ts               tanpa cookie sesi, halaman aplikasi dialihkan ke /masuk?next=
src/features/<area>/       layar per area: account, audit, auth, billing (langganan, paket, dan tagihan), business (profil bisnis dan legalitas), courier-hours (cut-off kurir, hari libur kurir, jam operasional), dashboard, listing-copy, listings, migration, orders, printers, products, reports, returns, settings (notifikasi, ekspor data), shipping, stock, stock-ops, stores, team, warehouses
src/components/ui/         komponen shadcn/ui (Radix), disesuaikan dengan token desain
src/components/common/     PageHeader, StatusPill, SlaPill, EmptyState, ErrorState, KpiTile, Segmented, Field, FilterChip, ikon kanal
src/components/shell/      sidebar, bar atas, navigasi bawah, notifikasi, menu pengguna
src/lib/api/               klien openapi-fetch, unwrap, ApiError (Problem Details), tipe hasil generate
src/lib/session.tsx        GET /v1/me, useCan (izin), useTimeZone (zona waktu bisnis)
src/lib/format.ts          rupiah, angka, tanggal, hitung mundur batas kirim
src/hooks/                 useUrlParams (filter di URL), useIsMobile
src/test/                  harness tes: renderApp, mockApi, next/navigation tiruan
```

## Aturan

- Semua akses API lewat `api` dan `unwrap` dari `@/lib/api/client`. `unwrap` mengembalikan data atau melempar `ApiError` dengan kode dan pesan dari api; layar hanya menangani bentuk sukses. Respons 401 di luar `/v1/auth/` mengirim pengguna ke `/masuk?next=`.
- Kontrak API berubah: jalankan `pnpm openapi:emit` di `backend/`, lalu `pnpm api:types` di sini, lalu `pnpm typecheck`. Jangan menulis tipe respons dengan tangan.
- Teks antarmuka hanya di `messages/id.json`, Bahasa Indonesia, kalimat lengkap. Angka di dalam teks memakai `{count, number}`.
- Tanggal ditampilkan dalam zona waktu bisnis: `formatDateTime(value, useTimeZone())`, bukan zona waktu browser. Uang selalu `formatRupiah`.
- Aksi yang tidak diizinkan disembunyikan (`useCan()`); api tetap menolaknya dengan 403.
- Toko yang masih mode uji berdampingan (`syncMode: read_only`): api menolak langkah penjual pada pesanan dan retur tokonya (409 `store.read_only`). Layar menyembunyikan aksi itu lewat `useStores().readOnly(storeId)` dan menjelaskan di mana harus dikerjakan; penerimaan barang retur tetap boleh.
- Menyimpan sesuatu yang bisa diubah dua orang bersamaan (produk): baca dengan `unwrapWithEtag`, simpan dengan header `If-Match` berisi ETag itu; api menolak bila ada yang menyimpan lebih dulu.
- Pindaian dikirim lewat `ScanBuffer`: kode yang sama dalam jeda singkat menjadi satu request dengan jumlahnya. Satu request per unit menghabiskan batas 600 request per menit per bisnis.
- Membuat dokumen dengan `Idempotency-Key` (transfer stok): satu kunci per formulir yang terbuka (`crypto.randomUUID()`), agar klik ganda atau ulangan setelah jawaban hilang tidak membuat dua dokumen.
- Pilihan cetak stasiun (agen cetak, format, templat) disimpan di `localStorage` browser itu saja, karena tiap PC kemas punya printernya sendiri. Bacaan dan tulisannya dibungkus `try/catch`, dan tanpa storage nilai bawaan berlaku. Tanpa agen cetak, dokumen diunduh sebagai PDF.
- Filter daftar disimpan di URL (`useUrlParams`), sehingga tampilan bisa dibagikan dan notifikasi bisa menautkan ke daftar yang sudah tersaring.
- Grafik mengikuti DOKUMEN-UI-UX 13: warna dari token CSS (`--chart-1` sampai `--chart-8` per entitas lewat `channelChartSlot`, `--seq-1` sampai `--seq-8` untuk besaran), dibaca ulang saat tema berganti; legenda untuk dua seri atau lebih; setiap grafik punya "Lihat tabel" dan "Unduh". ECharts dimuat dengan `next/dynamic` tanpa SSR; di tes komponen grafiknya diganti tiruan (`vi.mock`), karena jsdom tidak punya canvas.
- Status selalu ikon, teks, dan warna sekaligus (`StatusPill`). Ikon kanal di samping namanya yang tertulis memakai `decorative`, agar pembaca layar tidak menyebut nama dua kali.
- Data pembeli (nama, telepon, alamat) tidak boleh masuk `console`, `localStorage`, atau URL.
- Pindah ke alamat lain dengan muat ulang penuh (halaman izin marketplace, masuk ulang) lewat `leaveTo` dari `@/lib/navigate`, agar bisa diganti di tes.
- Komponen shadcn baru: `pnpm exec shadcn add <nama>`, lalu sesuaikan dengan token di `globals.css`.

## Pengujian

Tes berada di samping kodenya (`*.test.ts`, `*.test.tsx`). Tes komponen memakai `renderApp` (pesan, TanStack Query, sesi, tooltip), `mockApi` (menjawab `fetch` per `"METHOD /path"` dan mencatat setiap panggilan beserta body-nya), dan `setUrl` atau `currentUrl` untuk `next/navigation` tiruan yang dipasang `src/test/setup.ts`. Tes memeriksa permintaan yang dikirim ke api, bukan detail implementasi.

## Uji end-to-end

`e2e/` berisi uji Playwright terhadap web app hasil build dan backend yang berjalan: masuk dan daftar, pesanan sampai dikirim (terima, kemas dengan scan, label PDF, serah terima), pindai untuk cetak di agen cetak, batal manifest, label barcode PDF, stok (sesuaikan, opname, transfer), katalog, migrasi (impor, hapus pemetaan tersimpan), log audit (perubahan harga per SKU, filter jenis), ubah kata sandi lalu masuk dengan yang baru, profil bisnis (NIB, NPWP, nama baru di menu profil, dokumen dengan masa berlakunya), verifikasi dua langkah (menyalakan, lalu masuk dengan kode dari aplikasi dan dengan kode cadangan), cut-off kurir (pesanan mendapat pickup-nya lewat worker, hari libur, jam operasional), langganan (uji coba Growth, turun ke Starter, kuota gudang berlaku; membayar Growth di halaman Xendit tiruan lalu mengunduh PDF tagihan sebelum dan sesudah lunas), dan pemeriksaan axe (WCAG 2 A dan AA) di halaman harian. Setiap tes mendaftarkan bisnisnya sendiri lewat API (`e2e/fixtures.ts`) dengan alamat klien acak di `CF-Connecting-IP`, karena api membatasi pendaftaran per alamat. Karena itu tes tidak saling bergantung dan bisa berjalan paralel. Agen cetak dipasangkan lewat api, lalu melapor dengan token perangkatnya sendiri dari `playwright.request.newContext`, tanpa cookie sesi; pekerjaan cetaknya baru terlihat setelah worker selesai membuat PDF, jadi tes menunggunya dengan `expect.poll`. Kode aplikasi autentikator dihitung di tes sendiri (`totp` di `e2e/security.spec.ts`, RFC 6238 dengan `node:crypto`), dari kunci yang tampil di dialog.

Uji bayar langganan berjalan hanya dengan `E2E_FAKE_XENDIT=1` (CI menyetelnya): backend harus memakai Xendit tiruan (`pnpm mock:xendit` di `backend/`, port 57480) dengan `BILLING_PAYMENTS=xendit`, `XENDIT_API_BASE_URL=http://127.0.0.1:57480`, `XENDIT_SECRET_KEY=xnd_development_test_key_000000`, dan `XENDIT_WEBHOOK_TOKEN=callback-verification-token-test`, serta proses webhook di port 3001. Halaman bayar tiruan mengirim callback lunas ke proses webhook lalu kembali ke `/langganan?bayar=sukses`, seperti mode uji Xendit. Tanpa flag itu tesnya dilewati, misalnya terhadap staging yang memakai Xendit sungguhan.

```bash
# backend berjalan (pnpm dev di backend/) dan web app hasil build berjalan di port 3100
E2E_CHROME=1 pnpm e2e        # memakai Google Chrome yang terpasang
pnpm exec playwright install chromium && pnpm e2e   # atau Chromium milik Playwright
```

CI (`.github/workflows/ci.yml`) menjalankan hal yang sama terhadap stack yang dibangun di runner.

## Jebakan yang sudah pernah terjadi

- Tombol kartu paket di `/langganan` mengikuti `planAction` (`features/billing/billing-meta.ts`), cermin aturan api `planChoice` (backend `billing-plan.ts`): naik paket berlaku saat dibayar, turun paket di akhir periode yang dibayar, selama periode berikutnya sudah dibayar paket lain terkunci. Ubah keduanya bersama, atau layar menawarkan pilihan yang ditolak api.
- Berkas dari api (PDF tagihan `/v1/billing/invoices/{id}/pdf`, dokumen legalitas, contoh label) dibuka dengan tautan biasa ke `/v1/...`: cookie sesi ikut terkirim dan api menamai berkasnya lewat `Content-Disposition`. Jangan mengambilnya dengan `api` lalu membuat blob; PDF tagihan memuat NPWP dan alamat bisnis, jadi tidak disimpan di browser selain sebagai unduhan.
- Halaman pembayaran Xendit mengembalikan penjual ke `/langganan?bayar=sukses` atau `?bayar=gagal`. Parameter itu hanya dibaca sekali (toast) lalu dihapus dari alamat dengan `router.replace`; status paket sendiri datang dari api setelah callback Xendit, jadi halaman memuat ulang `GET /v1/billing/subscription` setiap 5 detik selama ada tagihan yang menunggu, dan tidak pernah menyimpulkan "lunas" dari parameter URL.

- `API_ORIGIN` dibaca saat `next build`: rewrites masuk ke hasil build. Build untuk smoke lokal dengan `API_ORIGIN=... pnpm build`.
- Fitur paket: `useHasFeature("custom_roles")` (`src/lib/session.tsx`) membaca `plan.features` dari `GET /v1/me`. Layar menyembunyikan yang tidak termasuk paket dan menjelaskan alasannya (tab Peran di `/tim`); api tetap menolaknya (422 `billing.feature_unavailable`).
- Tabel tanpa tautan atau tombol yang bisa tergeser ke samping di ponsel (matriks izin) memakai `<Table scrollLabel="...">`: wadahnya menjadi region berlabel yang bisa difokus dan digeser dengan keyboard.
- `NEXT_PUBLIC_SITE_URL` (opsional, juga saat build): alamat situs publik `website/`. Persetujuan di halaman Daftar lalu menautkan Syarat Layanan dan Kebijakan Privasi di sana (`siteUrl` di `src/lib/site.ts`); tanpa alamat itu dokumennya hanya disebut.
- Header tabel `sticky` di dalam kontainer `overflow-x-auto` tidak menempel ke halaman; ia bergeser sebesar `top` dan menutupi baris pertama.
- openapi-fetch membaca respons `default` sebagai error, sehingga data bertipe `never`. Backend menamai status sukses setiap operasi (`nameSuccessStatuses`); jangan menambal tipe di sini.
- Input angka di formulir disimpan sebagai teks dan diubah oleh skema Zod (`z.string().regex(...).transform(Number)`), bukan `valueAsNumber`: nilai kosong menjadi `NaN` dan browser memperingatkannya.
- Komponen yang memakai `useSearchParams` dibungkus `Suspense` di halamannya, atau build gagal saat prerender.
- Next 16: middleware bernama `proxy.ts`, `params` halaman adalah Promise, dan `error.tsx` menerima `retry`. Panduan versi terpasang ada di `node_modules/next/dist/docs/`.
- Dialog dan sheet Radix butuh judul; saat memuat pakai `SheetTitle` dengan `sr-only`.
- Di browser sungguhan, pengumum rute Next.js juga ber-`role="alert"`: di uji e2e cari pesannya (`getByRole("alert").filter({ hasText })`), bukan sekadar alert pertama.
- Pilihan yang tidak punya panel sendiri (rentang dasbor) adalah radio, bukan Tabs: Tabs tanpa panel membuat `aria-controls` menunjuk ke elemen yang tidak ada (axe: kritis). `Segmented` memakai `<input type="radio">` asli; di Playwright klik labelnya, karena inputnya `sr-only`.
- Pesan error formulir di dalam dialog yang bergulir diletakkan di dekat tombol yang memicunya (`FormAlert`), bukan di atas: penolakan api dari tombol di bawah tidak terlihat bila pesannya di luar layar.
- Menyimpan draf salinan hanya mengirim bagian yang berubah (`draftPatch`): deskripsi yang dikirim ulang tanpa diubah akan mengganti deskripsi HTML asal dengan teks biasa, dan atribut serta varian selalu diganti seluruhnya.
- Satuan yang tampil terpilih harus ikut tersimpan: nilai atribut yang diketik mengambil satuan pertama sampai pengguna memilih yang lain (`AttributeInput`). Sebelumnya "g" tampil tetapi tidak terkirim.
- Pemeriksaan axe pada dialog menunggu animasi munculnya selesai; selama memudar teksnya setengah transparan dan axe melaporkan kontras rendah yang tidak nyata.
- Pencarian yang menunggu jeda ketik hanya menampilkan hasil bila katanya sama dengan isi kotak saat ini. Hasil kata sebelumnya yang masih tampil sempat menerima klik, dan di pesanan manual klik untuk "tumbler" menambah kaos lagi.
- `Segmented` memakai `block` untuk pilihan berlabel panjang di dalam formulir: lebar penuh, pilihan sama lebar, teks boleh turun baris. Tanpa itu labelnya tidak pernah patah dan melebar keluar kartu di ponsel.
- `TabsList` bawaan memakai `justify-center`: tab yang meluap di ponsel terpotong di kiri dan tidak bisa digulir ke sana. Daftar tab yang bisa lebih lebar dari layar diberi `max-w-full justify-start overflow-x-auto`.
- "Bulan ini" di laporan penjualan diminta sebagai bulan kalender penuh (tanggal 1 sampai akhir bulan), bukan tanggal 1 sampai hari ini: hanya dengan begitu api membandingkannya dengan bulan lalu sampai titik yang sama (backend 8.20). Hari yang belum lewat dipotong dari grafik (`trendPoints`).
- jsdom tidak punya `URL.createObjectURL`; `src/test/setup.ts` memasang penggantinya untuk pratinjau foto.
- Garis kecil Riwayat Stok memberi setiap mutasi satu langkah selebar sama, bukan posisi menurut waktu. Smoke menemukan bahwa dengan sumbu waktu, empat mutasi beruntun berjarak detik menumpuk di satu piksel, dan nilai terakhir tidak bisa disorot sama sekali. SVG dengan `preserveAspectRatio="none"` meregangkan lingkaran; penanda titik digambar sebagai garis nol panjang berujung bulat dengan `vector-effect: non-scaling-stroke`. jsdom selalu menjawab `getBoundingClientRect` dengan nol, sehingga tes hover mengganti nilainya per elemen (`vi.spyOn`) dan komponennya mengabaikan lebar nol.
- `DropdownMenu` tidak modal secara bawaan (`components/ui/dropdown-menu.tsx`). Menu modal Radix memberi `aria-hidden` ke seluruh halaman selagi terbuka, termasuk tautan sidebar, dan axe menandainya `aria-hidden-focus` (serius).
- Sel tabel shadcn (`TableCell`, `TableHead`) memakai `whitespace-nowrap`. Sel berisi kalimat panjang (pesan galat log sinkron, catatan kartu stok) diberi `whitespace-normal`; tanpa itu tabel melebar dan tombol di kolom kanan terpotong.
- Ikon kanal menulis hurufnya (S, T) di dalam elemen, sehingga ikut terbaca di `textContent` item menu atau baris. Di tes, cari item lewat nama aksesibelnya (`getByRole("menuitem", { name })`), bukan `textContent`.
- `Checkbox` menampilkan keadaan sebagian (`checked="indeterminate"`) sebagai garis, misalnya untuk tag yang hanya dipakai sebagian pesanan terpilih; pembaca layar menyebutnya `mixed`.
- Kartu stok menautkan nomor dokumen hanya bila pengguna boleh membuka layarnya (`documentHref`): opname butuh `inventory:count`, transfer `inventory:transfer`, pesanan dan retur `order:read`. Selain itu nomornya teks biasa.
- `Select` di dalam `<form>` memasang `<select>` asli tersembunyi. Bila nilainya sudah ada sebelum pilihannya dimuat (pengaturan cetak stasiun terbaca lebih dulu daripada daftar agen cetak), select itu melapor nilai kosong dan Radix meneruskannya sebagai `onValueChange("")`, sehingga pilihan terhapus dan label barcode sempat terkirim tanpa agen cetak. Pembungkus `components/ui/select.tsx` mengabaikan nilai kosong, jadi jangan memakai `""` sebagai nilai pilihan; pakai penanda seperti `NO_PRESET`.
- Kunci pesan next-intl bertipe: kunci dari data api (judul dan nama field log audit) disimpan sebagai daftar bertipe di `features/audit/audit-meta.ts`, dan `audit-meta.test.ts` memastikan setiap kunci ada di `messages/id.json`. Hanya label nilai yang dipinjam dari namespace layar lain (status toko, alasan stok) dicek dulu dengan `t.has` lalu di-cast, karena kuncinya dibentuk dari data.
- Halaman di luar sidebar (Akun saya) tidak punya item navigasi, jadi judul bilah atasnya diambil dari `OFF_NAV` di `components/shell/top-bar.tsx`.
- Bar aksi untuk yang dipilih memakai `SelectionBar` (`components/common/selection-bar.tsx`). Di ponsel bar itu `fixed` di atas navigasi bawah, jadi tidak ikut memanjangkan halaman. App shell memberi ruang bawah lewat `has-[[data-slot=selection-bar]]` setinggi `--selection-bar-height`, yang diisi `ResizeObserver` dari tinggi bar sebenarnya: bar pesanan terlipat tiga baris di ponsel (130 px) dan menutupi kartu terakhir saat ruangnya masih tetap.
- api tidak pernah menjawab 304: setiap responsnya `Cache-Control: no-store`, dan `If-None-Match` dibuang (backend 8.29). `ETag` api adalah versi baris untuk `If-Match`. Sebelumnya browser mengirim `If-None-Match` berisi versi profil bisnis, Express menjawab 304, dan dokumen yang baru diunggah tidak muncul walau query sudah di-invalidate, karena dokumen tidak menaikkan versi profil.
- Formulir yang memegang draf tidak di-remount (`key`) saat bagian lain halaman berubah. Mengganti logo sempat me-remount formulir profil bisnis dan menghapus isian yang belum disimpan. Setelah simpan, draf diisi dari jawaban api (`setDraft(draftOf(next))`), sehingga nomor tampil seperti yang tersimpan.
- Tombol atau tautan yang berulang per baris ("Buka" di Perlu tindakan, "Lihat" di dokumen) diberi `aria-label` yang menyebut objeknya (`Buka: {title}`, `Lihat {title}`). Pembaca layar sering menelusuri daftar tautan saja, dan nama yang sama di setiap baris tidak bisa dibedakan.
- Toast Sonner juga sebuah `list`. Daftar di halaman yang memakai toast diberi `aria-label`, dan tes mencarinya dengan nama (`getByRole("list", { name: "Dokumen legalitas" })`).
- Input kode 6 angka memakai `CodeInput` (`features/auth/code-input.tsx`, di atas input-otp): enam kotak di atas satu input asli, sehingga label, tempel, dan isi otomatis kode dari ponsel bekerja. input-otp memanggil `document.elementFromPoint` untuk mencari lencana pengelola kata sandi; jsdom tidak punya, jadi `src/test/setup.ts` memasang penggantinya.
- Komponen tidak didefinisikan di dalam komponen lain. Komponen dalam dibuat ulang setiap kali induknya render, dan isian formulirnya hilang; formulir mematikan 2FA sempat ditulis begitu sebelum dipindah ke tingkat modul.
- Isi yang hanya tampil sekali (kode cadangan) ditutup hanya lewat tombolnya: `onOpenChange` mengabaikan Escape dan klik di luar, dan `showCloseButton={false}`. "Selesai" baru aktif setelah "Saya sudah menyimpan kode ini" dicentang.
- `CardAction` turun ke bawah keterangan pada kartu sempit (container query `@md/card-header`), bukan berdiri di samping judul: di ponsel, tombol "Tambah periode" sempat menghimpit judul dan keterangan kartu menjadi satu kolom sempit. Kartu lebar tidak berubah.
- Batas kirim pesanan lewat `DeadlinePill` (`features/orders/deadline-pill.tsx`) dan `pickupAhead`/`missedPickup` (`order-meta.ts`): pickup kurir tampil hanya bila datang lebih dulu dari batas marketplace dan belum lewat; pickup yang terlewat menjadi catatan di bawah batas marketplace, karena batas marketplace tetap berlaku.
- `input type="time"` dan `type="date"` tidak bisa diketik dengan `userEvent.type` di jsdom; tes mengisinya dengan `fireEvent.change`.
