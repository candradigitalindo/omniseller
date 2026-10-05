# OmniSeller Web

Web app OmniSeller untuk penjual: Next.js 16 (App Router), React 19, Tailwind CSS 4, shadcn/ui, TanStack Query, dan klien API bertipe dari `backend/openapi.json`. Keputusan teknologinya ada di `DOKUMEN-TEKNOLOGI.md` bagian 9 dan ADR-039; spesifikasi layar di `DOKUMEN-UI-UX.md`.

Layar yang sudah ada: masuk, daftar, lupa dan atur ulang kata sandi, undangan (L49 dan sekitarnya), Ringkasan (L01), Pesanan dengan panel detail (L03, L04), Pengiriman dengan kemas dengan scan, cetak label dan daftar ambil, antrean cetak, dan serah terima kurir (L05 sampai L08), Retur & Batal dengan keputusan, foto bukti, dan penerimaan barang (L09), Produk dengan tambah manual, impor CSV, dan halaman detail (Informasi, Varian, Listing tertaut, Riwayat; L13, L14), Listing Toko dengan progres dan pemetaan SKU (L15), Stok dengan dialog Sesuaikan stok (L19), Stock Opname dengan pindai, tinjau, dan terapkan (L22), Transfer Stok dari draf sampai diterima (L23), dan Toko Terhubung dengan wizard hubungkan toko dan halaman callback otorisasi (L40).

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
src/features/<area>/       layar per area: auth, dashboard, listings, orders, products, returns, shipping, stock, stock-ops, stores
src/components/ui/         komponen shadcn/ui (Radix), disesuaikan dengan token desain
src/components/common/     PageHeader, StatusPill, SlaPill, EmptyState, ErrorState, Field, FilterChip, ikon kanal
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
- Status selalu ikon, teks, dan warna sekaligus (`StatusPill`). Ikon kanal di samping namanya yang tertulis memakai `decorative`, agar pembaca layar tidak menyebut nama dua kali.
- Data pembeli (nama, telepon, alamat) tidak boleh masuk `console`, `localStorage`, atau URL.
- Pindah ke alamat lain dengan muat ulang penuh (halaman izin marketplace, masuk ulang) lewat `leaveTo` dari `@/lib/navigate`, agar bisa diganti di tes.
- Komponen shadcn baru: `pnpm exec shadcn add <nama>`, lalu sesuaikan dengan token di `globals.css`.

## Pengujian

Tes berada di samping kodenya (`*.test.ts`, `*.test.tsx`). Tes komponen memakai `renderApp` (pesan, TanStack Query, sesi, tooltip), `mockApi` (menjawab `fetch` per `"METHOD /path"` dan mencatat setiap panggilan beserta body-nya), dan `setUrl` atau `currentUrl` untuk `next/navigation` tiruan yang dipasang `src/test/setup.ts`. Tes memeriksa permintaan yang dikirim ke api, bukan detail implementasi.

## Uji end-to-end

`e2e/` berisi uji Playwright terhadap web app hasil build dan backend yang berjalan: masuk dan daftar, pesanan sampai dikirim (terima, kemas dengan scan, label PDF, serah terima), stok (sesuaikan, opname, transfer), katalog, dan pemeriksaan axe (WCAG 2 A dan AA) di halaman harian. Setiap tes mendaftarkan bisnisnya sendiri lewat API (`e2e/fixtures.ts`) dengan alamat klien acak di `CF-Connecting-IP`, karena api membatasi pendaftaran per alamat. Karena itu tes tidak saling bergantung dan bisa berjalan paralel.

```bash
# backend berjalan (pnpm dev di backend/) dan web app hasil build berjalan di port 3100
E2E_CHROME=1 pnpm e2e        # memakai Google Chrome yang terpasang
pnpm exec playwright install chromium && pnpm e2e   # atau Chromium milik Playwright
```

CI (`.github/workflows/ci.yml`) menjalankan hal yang sama terhadap stack yang dibangun di runner.

## Jebakan yang sudah pernah terjadi

- `API_ORIGIN` dibaca saat `next build`: rewrites masuk ke hasil build. Build untuk smoke lokal dengan `API_ORIGIN=... pnpm build`.
- Header tabel `sticky` di dalam kontainer `overflow-x-auto` tidak menempel ke halaman; ia bergeser sebesar `top` dan menutupi baris pertama.
- openapi-fetch membaca respons `default` sebagai error, sehingga data bertipe `never`. Backend menamai status sukses setiap operasi (`nameSuccessStatuses`); jangan menambal tipe di sini.
- Input angka di formulir disimpan sebagai teks dan diubah oleh skema Zod (`z.string().regex(...).transform(Number)`), bukan `valueAsNumber`: nilai kosong menjadi `NaN` dan browser memperingatkannya.
- Komponen yang memakai `useSearchParams` dibungkus `Suspense` di halamannya, atau build gagal saat prerender.
- Next 16: middleware bernama `proxy.ts`, `params` halaman adalah Promise, dan `error.tsx` menerima `retry`. Panduan versi terpasang ada di `node_modules/next/dist/docs/`.
- Dialog dan sheet Radix butuh judul; saat memuat pakai `SheetTitle` dengan `sr-only`.
- Di browser sungguhan, pengumum rute Next.js juga ber-`role="alert"`: di uji e2e cari pesannya (`getByRole("alert").filter({ hasText })`), bukan sekadar alert pertama.
- Pilihan yang tidak punya panel sendiri (rentang dasbor) adalah radio, bukan Tabs: Tabs tanpa panel membuat `aria-controls` menunjuk ke elemen yang tidak ada (axe: kritis). `Segmented` memakai `<input type="radio">` asli; di Playwright klik labelnya, karena inputnya `sr-only`.
- Pesan error formulir di dalam dialog yang bergulir diletakkan di dekat tombol yang memicunya (`FormAlert`), bukan di atas: penolakan api dari tombol di bawah tidak terlihat bila pesannya di luar layar.
- jsdom tidak punya `URL.createObjectURL`; `src/test/setup.ts` memasang penggantinya untuk pratinjau foto.
