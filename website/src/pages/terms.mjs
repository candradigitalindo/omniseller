import { html } from "../html.mjs";
import { legalBody } from "../legal.mjs";

/** Syarat Layanan (PRD 12.7): scope, both sides' duties, limits, payment, termination, and data. */
export default {
  path: "/syarat-layanan/",
  title: "Syarat Layanan",
  description:
    "Syarat Layanan OmniSeller: cakupan layanan, akun, paket dan pembayaran, data Anda, penggunaan yang dilarang, batasan, dan penghentian.",
  body: (site) => {
    const c = site.company;
    const p = site.pricing;
    return legalBody(site, {
      title: "Syarat Layanan",
      summary: html`<p>Ringkasnya: OmniSeller adalah alat untuk mengelola toko marketplace Anda. Data bisnis dan toko tetap milik Anda dan bisa diekspor kapan saja. Paket berbayar ditagih per bulan di muka, naik paket berlaku saat dibayar, dan turun paket berlaku di akhir periode. Anda tetap bertanggung jawab atas toko, produk, dan pesanan Anda. Ringkasan ini tidak menggantikan isi lengkap di bawah.</p>`,
      sections: [
        {
          id: "tentang",
          title: "Tentang syarat ini",
          body: html`<p>Syarat Layanan ini mengatur penggunaan OmniSeller, layanan perangkat lunak berbasis web yang dikelola oleh ${c.legalName} ("kami"). Dengan mendaftar atau memakai OmniSeller, Anda, atas nama bisnis yang Anda daftarkan ("Anda"), menyetujui Syarat Layanan ini dan <a href="/kebijakan-privasi/">Kebijakan Privasi</a>. Orang yang mendaftar menyatakan berwenang mewakili bisnis itu.</p>
<p>Kami dapat mengubah syarat ini. Perubahan diberitahukan lewat email dan di dalam aplikasi paling lambat ${site.legal.changeNoticeDays} hari sebelum berlaku. Bila tidak setuju, Anda dapat berhenti memakai layanan sebelum perubahan berlaku.</p>`,
        },
        {
          id: "layanan",
          title: "Layanan",
          body: html`<p>OmniSeller menghubungkan toko Anda di Shopee dan Tokopedia &amp; Shop lewat antarmuka pemrograman (API) resmi marketplace, dengan otorisasi Anda, untuk mengelola pesanan, stok, gudang, pengiriman, katalog, retur, laporan, dan tim. Fitur dan kuota tiap paket tercantum di halaman <a href="/harga/">Harga</a>.</p>
<p>Kami terus mengembangkan layanan dan dapat mengubah atau menghentikan fitur. Perubahan yang mengurangi fungsi paket berbayar secara berarti diberitahukan sebelumnya.</p>`,
        },
        {
          id: "akun",
          title: "Akun, pengguna, dan keamanan",
          body: html`<ul>
<li>Isi data akun dan profil bisnis dengan benar dan perbarui bila berubah.</li>
<li>Jaga kerahasiaan kata sandi. Kami menyarankan verifikasi dua langkah untuk pemilik dan admin.</li>
<li>Anda bertanggung jawab atas pengguna yang Anda undang dan hak akses yang Anda berikan kepada mereka.</li>
<li>Beri tahu kami segera bila ada penggunaan akun tanpa izin.</li>
</ul>`,
        },
        {
          id: "marketplace",
          title: "Toko marketplace dan otorisasi",
          body: html`<p>Saat menghubungkan toko, Anda memberi OmniSeller izin membaca data toko dan bertindak atas nama Anda lewat API marketplace, misalnya memperbarui stok, menerima pesanan, mengatur pengiriman, dan menanggapi retur, sesuai pengaturan dan tindakan Anda. Izin ini dapat Anda cabut kapan saja dengan memutus toko di OmniSeller atau di seller center marketplace.</p>
<p>Anda tetap bertanggung jawab atas toko, produk, harga, pesanan, layanan pembeli, dan kepatuhan pada kebijakan tiap marketplace. Marketplace dapat mengubah atau menghentikan API dan kebijakannya di luar kendali kami.</p>`,
        },
        {
          id: "paket",
          title: "Paket, uji coba, dan pembayaran",
          body: html`<ul>
<li>Bisnis baru mendapat uji coba ${p.trialDays} hari dengan fitur dan kuota paket Growth, tanpa biaya. Setelah itu bisnis memakai paket yang dipilih dan dibayar, atau kembali ke Starter secara otomatis.</li>
<li>Paket berbayar ditagih per bulan, di muka, dengan harga yang berlaku di halaman <a href="/harga/">Harga</a> saat tagihan dibuat, dan dibayar lewat halaman pembayaran Xendit. ${p.taxNote}</li>
<li>Naik paket berlaku saat dibayar, selama satu bulan sejak dibayar. Sisa periode berbayar yang belum terpakai dipotong dari tagihannya.</li>
<li>Turun paket, termasuk ke Starter, berlaku di akhir periode yang sudah dibayar.</li>
<li>Tagihan perpanjangan dibuat ${p.renewalNoticeDays} hari sebelum periode berakhir. Bila belum dibayar saat periode berakhir, paket tetap aktif ${p.graceDays} hari, lalu bisnis kembali ke Starter.</li>
<li>Perubahan harga diumumkan sebelum berlaku dan tidak mengubah periode yang sudah dibayar.</li>
<li>Pengembalian dana diatur dalam <a href="/kebijakan-pengembalian-dana/">Kebijakan Pengembalian Dana</a>.</li>
</ul>`,
        },
        {
          id: "kuota",
          title: "Kuota",
          body: html`<p>Setiap paket punya kuota toko marketplace, gudang, pesanan per bulan, dan pengguna. Pesanan yang masuk tidak pernah ditolak karena kuota; Anda diberi tahu saat pemakaian mencapai 80% dan 100%. Menambah toko, gudang, atau pengguna melebihi kuota tidak bisa dilakukan. Setelah turun paket, data yang melebihi kuota tidak dihapus.</p>`,
        },
        {
          id: "data",
          title: "Data Anda",
          body: html`<ul>
<li>Data bisnis dan data toko Anda tetap milik Anda. Kami memakainya hanya untuk menyediakan layanan, seperti dijelaskan dalam <a href="/kebijakan-privasi/">Kebijakan Privasi</a>.</li>
<li>Untuk data pembeli yang datang dari marketplace, Anda adalah pengendali data dan kami memprosesnya atas nama Anda. Pakai data pembeli hanya untuk memenuhi pesanan, sesuai kebijakan marketplace dan peraturan pelindungan data pribadi.</li>
<li>Anda dapat mengekspor seluruh data kapan saja dari menu Ekspor data.</li>
<li>Setelah akun ditutup, kami menghapus data Anda dalam ${site.legal.deletionDays} hari, kecuali data yang wajib kami simpan menurut hukum, seperti tagihan dan catatan perpajakan.</li>
</ul>`,
        },
        {
          id: "larangan",
          title: "Penggunaan yang dilarang",
          body: html`<p>Anda tidak boleh memakai OmniSeller untuk:</p>
<ul>
<li>menjual barang atau jasa yang dilarang hukum atau kebijakan marketplace;</li>
<li>mengirim spam atau pesan yang mengganggu kepada pembeli;</li>
<li>menyalin konten pihak lain, termasuk foto dan deskripsi produk, untuk diterbitkan ulang tanpa hak;</li>
<li>mengumpulkan data di luar yang diizinkan marketplace atau peraturan;</li>
<li>berbagi satu akun pengguna dengan beberapa orang, atau menjual kembali akses OmniSeller;</li>
<li>mencoba menembus keamanan, membebani sistem secara tidak wajar, atau membongkar perangkat lunak kami.</li>
</ul>`,
        },
        {
          id: "batasan",
          title: "Batasan layanan",
          body: html`<ul>
<li>Laporan, laba, dan angka pajak di OmniSeller adalah data pendukung, bukan perhitungan kewajiban pajak resmi. Periksa kembali sebelum dipakai untuk keperluan pajak atau keuangan.</li>
<li>Kami tidak menjamin kebijakan, ketersediaan, atau keputusan marketplace dan ekspedisi, termasuk penalti dan pembatasan toko.</li>
<li>Sinkron stok dan pesanan bergantung pada API marketplace. Gangguan di pihak marketplace dapat menunda pembaruan.</li>
</ul>`,
        },
        {
          id: "ketersediaan",
          title: "Ketersediaan dan dukungan",
          body: html`<p>Kami menargetkan layanan tersedia 99,5% setiap bulan. Pemeliharaan terjadwal dilakukan paling lama 4 jam per bulan antara pukul 01.00 dan 04.00 WIB dan diumumkan 3 hari sebelumnya. Gangguan API marketplace, ekspedisi, dan keadaan kahar tidak dihitung sebagai gangguan OmniSeller. Kanal dan jam dukungan tiap paket tercantum di halaman <a href="/harga/">Harga</a>. Jaminan tingkat layanan tertulis, bila ada, diatur dalam lampiran tersendiri untuk paket Business.</p>`,
        },
        {
          id: "hki",
          title: "Kekayaan intelektual",
          body: html`<p>Perangkat lunak, merek, dan materi OmniSeller milik ${c.legalName}. Selama berlangganan, Anda mendapat hak terbatas, tidak eksklusif, dan tidak dapat dialihkan untuk memakai OmniSeller bagi bisnis Anda. Konten yang Anda unggah tetap milik Anda. Masukan yang Anda berikan boleh kami pakai untuk memperbaiki layanan.</p>`,
        },
        {
          id: "tanggung-jawab",
          title: "Batas tanggung jawab",
          body: html`<p>Sejauh diizinkan hukum, kami tidak bertanggung jawab atas kerugian tidak langsung, seperti kehilangan keuntungan, penalti marketplace, atau hilangnya kesempatan usaha. Tanggung jawab kami secara keseluruhan paling banyak sebesar biaya langganan yang Anda bayar dalam 3 bulan sebelum kejadian.</p>`,
        },
        {
          id: "penghentian",
          title: "Penghentian",
          body: html`<p>Anda dapat berhenti berlangganan kapan saja dengan memilih paket Starter, atau meminta penutupan akun lewat <a href="mailto:${site.contact.email}">${site.contact.email}</a>. Kami dapat menangguhkan atau menghentikan akun yang melanggar Syarat Layanan ini secara serius, dengan pemberitahuan lebih dulu bila memungkinkan. Sebelum data dihapus, Anda tetap dapat mengekspornya.</p>`,
        },
        {
          id: "hukum",
          title: "Hukum yang berlaku dan sengketa",
          body: html`<p>Syarat Layanan ini tunduk pada hukum Republik Indonesia. Sengketa diselesaikan lebih dulu secara musyawarah dalam ${site.legal.disputeDays} hari sejak salah satu pihak memberitahukannya. Bila tidak selesai, sengketa diselesaikan di ${c.court}.</p>`,
        },
        {
          id: "kontak",
          title: "Kontak",
          body: html`<p>${c.legalName}<br>${c.address}<br>Email <a href="mailto:${site.contact.email}">${site.contact.email}</a></p>`,
        },
      ],
    });
  },
};
