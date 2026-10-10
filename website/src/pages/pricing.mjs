import { count, html, rupiah } from "../html.mjs";
import { appLink } from "../layout.mjs";

/** "2 toko marketplace", "Toko marketplace tidak dibatasi". */
function limitLines(limits) {
  const line = (value, unit, unlimited) => (value === null ? unlimited : `${count(value)} ${unit}`);
  return [
    line(limits.stores, "toko marketplace", "Toko marketplace tidak dibatasi"),
    line(limits.warehouses, "gudang", "Gudang tidak dibatasi"),
    line(limits.ordersPerMonth, "pesanan per bulan", "Pesanan tidak dibatasi"),
    line(limits.users, "pengguna", "Pengguna tidak dibatasi"),
  ];
}

const FAQ = [
  {
    q: "Apakah uji coba perlu kartu kredit?",
    a: "Tidak. Daftar saja: bisnis baru langsung memakai fitur dan kuota Growth selama uji coba.",
  },
  {
    q: "Apa yang terjadi bila pesanan melebihi kuota?",
    a: "Pesanan tetap masuk dan diproses. Anda diberi tahu saat pemakaian bulan itu mencapai 80% dan 100% kuota, dan bisa naik paket kapan saja.",
  },
  {
    q: "Bisakah berhenti kapan saja?",
    a: "Bisa. Pilih paket Starter di menu Langganan & Tagihan. Paket berbayar tetap aktif sampai akhir periode yang sudah dibayar, dan tidak ada kontrak tahunan.",
  },
  {
    q: "Apakah data saya bisa dibawa pergi?",
    a: "Bisa. Ekspor data lengkap (berkas CSV dalam satu ZIP) dari menu Ekspor data kapan saja, di paket apa pun.",
  },
  {
    q: "Marketplace apa saja yang didukung?",
    a: "Shopee dan Tokopedia & Shop. Pesanan dari kanal lain, seperti WhatsApp atau toko offline, dicatat sebagai pesanan manual.",
  },
];

export default {
  path: "/harga/",
  title: "Harga",
  description:
    "Paket OmniSeller: Starter gratis, Growth, dan Business, dibayar bulanan. Uji coba gratis dengan fitur Growth, tanpa kartu kredit.",
  body: (site) => html`<section class="section page-head">
  <div class="wrap">
    <h1>Harga</h1>
    <p class="lead">Semua fitur inti ada di setiap paket. Paket membedakan jumlah toko, gudang, pesanan, pengguna, fitur tambahan, dan layanan dukungan.</p>
  </div>
</section>

<section class="section" aria-label="Paket">
  <div class="wrap">
    <div class="cards three plans">${site.plans.map(
      (p) => html`<article class="card plan${p.code === "growth" ? " featured" : ""}" aria-labelledby="paket-${p.code}">
        <h2 id="paket-${p.code}">${p.name}</h2>
        <p class="muted">${p.audience}</p>
        <p class="price">${rupiah(p.priceMonthly)}${p.priceMonthly > 0 ? html`<span> per bulan</span>` : ""}</p>
        <ul class="ticks">${limitLines(p.limits).map((l) => html`<li>${l}</li>`)}<li>Semua fitur inti</li>${p.extras.map(
          (e) => html`<li>${e}</li>`,
        )}</ul>
        <p class="support"><strong>Dukungan:</strong> ${p.support}</p>
        <a class="button${p.code === "growth" ? "" : " ghost"}" href="${appLink(site, "/daftar")}">${
          p.priceMonthly === 0 ? "Mulai gratis" : `Coba gratis ${site.pricing.trialDays} hari`
        }</a>
      </article>`,
    )}</div>
    <p class="muted center tax-note">${site.pricing.taxNote}</p>
  </div>
</section>

<section class="section alt" aria-labelledby="cara-bayar">
  <div class="wrap narrow">
    <h2 id="cara-bayar">Uji coba dan pembayaran</h2>
    <ul class="plain">
      <li>Setiap bisnis baru mendapat uji coba ${site.pricing.trialDays} hari dengan fitur dan kuota Growth. Bila tidak berlangganan, bisnis otomatis kembali ke Starter tanpa biaya.</li>
      <li>Paket berbayar ditagih per bulan, di muka, dan dibayar di halaman pembayaran Xendit. Metode yang tersedia tampil di halaman itu.</li>
      <li>Naik paket berlaku begitu dibayar, dan sisa periode yang sudah dibayar dipotong dari tagihannya. Turun paket berlaku di akhir periode yang sudah dibayar.</li>
      <li>Bila tagihan perpanjangan belum dibayar saat periode berakhir, paket tetap aktif ${site.pricing.graceDays} hari, lalu kembali ke Starter.</li>
      <li>Setelah turun paket, data yang melebihi kuota tidak dihapus, hanya tidak bisa ditambah.</li>
      <li>Setiap tagihan bisa diunduh sebagai PDF dengan NPWP bisnis Anda. Lihat juga <a href="/kebijakan-pengembalian-dana/">Kebijakan Pengembalian Dana</a>.</li>
    </ul>
  </div>
</section>

<section class="section" aria-labelledby="tanya-jawab">
  <div class="wrap narrow">
    <h2 id="tanya-jawab">Tanya jawab</h2>
    <div class="faq">${FAQ.map((f) => html`<details><summary>${f.q}</summary><p>${f.a}</p></details>`)}</div>
  </div>
</section>`,
};
