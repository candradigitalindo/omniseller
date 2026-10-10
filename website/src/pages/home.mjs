import { html } from "../html.mjs";
import { appLink } from "../layout.mjs";

/** What the app does today; nothing here is a plan for later (keep it so: the site is a promise). */
const FEATURES = [
  {
    title: "Satu antrean pesanan",
    text: "Pesanan Shopee dan Tokopedia & Shop masuk ke satu antrean. Terima, kemas, dan kirim tanpa berpindah seller center. Pesanan dari WhatsApp atau toko offline dicatat sebagai pesanan manual.",
  },
  {
    title: "Stok tersinkron otomatis",
    text: "Setiap perubahan stok dikirim ke semua toko. Kelola banyak gudang, stok opname, dan transfer antar gudang, lengkap dengan daftar barang yang perlu dipesan ulang.",
  },
  {
    title: "Cetak label sekaligus",
    text: "Label marketplace dicetak massal, ditambah daftar ambil, daftar kemas, dan label barcode. Agen cetak mengirim dokumen langsung ke printer gudang.",
  },
  {
    title: "Kemas dan serah terima dengan scan",
    text: "Scan resi untuk memastikan isi paket benar, lalu serahkan paket ke kurir dengan manifest serah terima. Batas pickup tiap kurir terlihat di setiap pesanan.",
  },
  {
    title: "Katalog dan listing",
    text: "Cocokkan SKU antar toko, lalu salin listing dari satu toko ke toko lain lewat draf yang Anda periksa sebelum terbit.",
  },
  {
    title: "Retur dan pembatalan",
    text: "Tanggapi permintaan retur, refund, dan pembatalan dari pembeli, lalu terima barang kembali ke stok atau karantina.",
  },
  {
    title: "Laporan penjualan dan laba",
    text: "Penjualan per toko dan produk, laba kotor dari harga pokok, dan ringkasan email harian tentang pesanan yang perlu ditangani.",
  },
  {
    title: "Tim dan keamanan",
    text: "Atur hak akses per toko dan per gudang, susun peran sendiri mulai paket Growth, aktifkan verifikasi dua langkah, dan lihat log audit untuk setiap perubahan penting.",
  },
  {
    title: "Pindah dari aplikasi lain",
    text: "Impor produk dan stok, jalankan OmniSeller berdampingan dengan aplikasi lama, lalu beralih begitu stok sudah cocok.",
  },
];

const STEPS = [
  {
    title: "Daftar dan hubungkan toko",
    text: "Hubungkan toko Shopee dan Tokopedia & Shop lewat halaman otorisasi resmi masing-masing marketplace.",
  },
  {
    title: "Cocokkan produk dan stok",
    text: "SKU dicocokkan otomatis. Stok awal dihitung sekali, lalu OmniSeller menjaganya tetap sama di semua toko.",
  },
  {
    title: "Proses pesanan setiap hari",
    text: "Antrean pesanan, label, kemas, dan serah terima kurir ada di satu tempat, untuk Anda dan tim.",
  },
];

export default {
  path: "/",
  title: "Kelola semua toko marketplace dari satu tempat",
  description:
    "OmniSeller menyatukan pesanan, stok, dan pengiriman toko Shopee dan Tokopedia & Shop. Stok tersinkron otomatis, label tercetak sekaligus, dan laba setiap pesanan terlihat.",
  body: (site) => html`<section class="hero">
  <div class="wrap">
    <p class="eyebrow">Untuk penjual Shopee dan Tokopedia &amp; Shop</p>
    <h1>Kelola semua toko marketplace dari satu tempat</h1>
    <p class="lead">OmniSeller menyatukan pesanan, stok, dan pengiriman dari semua toko Anda. Stok tersinkron otomatis, label tercetak sekaligus, dan laba setiap pesanan terlihat.</p>
    <div class="actions">
      <a class="button large" href="${appLink(site, "/daftar")}">Coba gratis ${site.pricing.trialDays} hari</a>
      <a class="button large ghost" href="/harga/">Lihat harga</a>
    </div>
    <p class="muted">Uji coba memakai fitur dan kuota paket Growth, tanpa kartu kredit.</p>
  </div>
</section>

<section class="section" aria-labelledby="untuk-siapa">
  <div class="wrap">
    <h2 id="untuk-siapa">Untuk siapa</h2>
    <div class="cards three">
      <div class="card"><h3>Pedagang solo</h3><p>Stok tidak pernah kacau lagi, label sekali cetak, dan Anda tahu untung tiap pesanan.</p></div>
      <div class="card"><h3>Toko menengah</h3><p>Tim bekerja dari satu antrean, dengan hak akses per toko dan gudang.</p></div>
      <div class="card"><h3>Brand dan distributor</h3><p>Banyak gudang, banyak toko, dan riwayat stok yang bisa ditelusuri.</p></div>
    </div>
  </div>
</section>

<section class="section alt" id="fitur" aria-labelledby="fitur-judul">
  <div class="wrap">
    <h2 id="fitur-judul">Fitur</h2>
    <p class="section-lead">Semua fitur inti tersedia di setiap paket, termasuk Starter yang gratis.</p>
    <div class="cards three">${FEATURES.map((f) => html`<div class="card"><h3>${f.title}</h3><p>${f.text}</p></div>`)}</div>
  </div>
</section>

<section class="section" aria-labelledby="cara-kerja">
  <div class="wrap">
    <h2 id="cara-kerja">Cara kerja</h2>
    <ol class="steps">${STEPS.map((s) => html`<li><h3>${s.title}</h3><p>${s.text}</p></li>`)}</ol>
  </div>
</section>

<section class="section cta" aria-labelledby="mulai">
  <div class="wrap">
    <h2 id="mulai">Mulai hari ini</h2>
    <p>Daftar dalam beberapa menit. Bila tidak berlangganan setelah uji coba, bisnis Anda kembali ke paket Starter tanpa biaya.</p>
    <div class="actions">
      <a class="button large light" href="${appLink(site, "/daftar")}">Coba gratis ${site.pricing.trialDays} hari</a>
      <a class="button large ghost light" href="/kontak/">Tanya dulu</a>
    </div>
  </div>
</section>`,
};
