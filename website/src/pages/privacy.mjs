import { html } from "../html.mjs";
import { legalBody } from "../legal.mjs";

/**
 * Kebijakan Privasi (PRD 12.1 and 12.7, UU 27/2022): what is processed, why, with whom, where, how long,
 * and the rights of the people it is about. Sub-processors follow technology doc 13 and 26; keep them in
 * step with what is actually used.
 */
const PROCESSORS = [
  ["Amazon Web Services", "Server, basis data, dan kunci enkripsi", "Indonesia (Jakarta)"],
  ["Cloudflare", "DNS, perlindungan jaringan, dan penyimpanan berkas (label, ekspor, gambar)", "Jaringan global Cloudflare"],
  ["Amazon SES", "Pengiriman email; email tidak memuat data pembeli", "Singapura"],
  ["Xendit", "Pembayaran langganan", "Menurut kebijakan privasi Xendit"],
  ["Grafana Cloud, Sentry, Better Stack", "Pemantauan, log, dan status layanan; tanpa data pembeli", "Di luar Indonesia"],
];

export default {
  path: "/kebijakan-privasi/",
  title: "Kebijakan Privasi",
  description:
    "Kebijakan Privasi OmniSeller: data yang diproses, tujuan dan dasarnya, sub-prosesor, lokasi penyimpanan, masa simpan, dan hak Anda menurut UU Pelindungan Data Pribadi.",
  body: (site) => {
    const c = site.company;
    return legalBody(site, {
      title: "Kebijakan Privasi",
      summary: html`<p>Ringkasnya: kami memproses data akun dan bisnis Anda untuk menjalankan layanan, dan data pembeli dari marketplace hanya atas nama Anda untuk memenuhi pesanan. Data utama disimpan di Indonesia. Kami tidak menjual data dan tidak memakai data pembeli untuk tujuan lain. Situs ini tidak memakai cookie pelacak.</p>`,
      sections: [
        {
          id: "peran",
          title: "Siapa kami dan peran kami",
          body: html`<p>OmniSeller dikelola oleh ${c.legalName}, ${c.address}. Untuk data akun, pengguna, dan profil bisnis Anda, kami adalah pengendali data pribadi. Untuk data pembeli yang datang dari toko marketplace Anda, Anda adalah pengendali dan kami adalah prosesor yang memprosesnya atas nama dan sesuai instruksi Anda, sebagaimana diatur Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi (UU PDP).</p>`,
        },
        {
          id: "data",
          title: "Data yang kami proses",
          body: html`<ul>
<li><strong>Akun dan pengguna:</strong> nama, email, kata sandi (disimpan sebagai hash, tidak pernah dalam bentuk asli), peran dan hak akses, pengaturan verifikasi dua langkah, serta perangkat dan sesi masuk.</li>
<li><strong>Profil bisnis:</strong> nama bisnis, alamat, telepon, NIB, NPWP, status PKP, logo, dan dokumen legalitas yang Anda unggah.</li>
<li><strong>Data toko dari marketplace:</strong> produk, listing, stok, pesanan, pengiriman, retur, dan data pembeli yang diperlukan untuk mengirim pesanan, yaitu nama, nomor telepon, alamat pengiriman, catatan pembeli, serta alasan dan foto retur.</li>
<li><strong>Langganan:</strong> paket, tagihan, dan status pembayaran. Data kartu atau rekening diproses oleh Xendit dan tidak disimpan oleh kami.</li>
<li><strong>Teknis:</strong> alamat IP, jenis peramban, dan catatan aktivitas untuk keamanan dan log audit.</li>
</ul>`,
        },
        {
          id: "tujuan",
          title: "Tujuan dan dasar pemrosesan",
          body: html`<ul>
<li>Menjalankan layanan sesuai perjanjian dengan Anda: sinkron stok dan pesanan, cetak label, laporan, dan dukungan.</li>
<li>Memenuhi kewajiban hukum, seperti pencatatan tagihan dan perpajakan.</li>
<li>Kepentingan yang sah: menjaga keamanan akun, mencegah penyalahgunaan, dan memperbaiki layanan dengan data yang tidak mengenali orang.</li>
<li>Memproses data pembeli hanya atas instruksi Anda, untuk memenuhi pesanan dan retur.</li>
</ul>
<p>Kami tidak menjual data pribadi, tidak menggabungkan data pembeli antar penjual, dan tidak memakai data pembeli untuk iklan.</p>`,
        },
        {
          id: "berbagi",
          title: "Dengan siapa data dibagikan",
          body: html`<p>Kami memakai penyedia berikut (sub-prosesor) untuk menjalankan layanan, masing-masing hanya untuk keperluannya:</p>
<div class="table-wrap"><table>
<thead><tr><th scope="col">Penyedia</th><th scope="col">Keperluan</th><th scope="col">Lokasi</th></tr></thead>
<tbody>${PROCESSORS.map(([name, use, where]) => html`<tr><td>${name}</td><td>${use}</td><td>${where}</td></tr>`)}</tbody>
</table></div>
<p>Data toko dipertukarkan dengan marketplace yang Anda hubungkan (Shopee, Tokopedia &amp; Shop) sesuai otorisasi Anda. Kami dapat mengungkapkan data bila diwajibkan hukum atau perintah pihak berwenang.</p>`,
        },
        {
          id: "lokasi",
          title: "Lokasi dan keamanan data",
          body: html`<p>Basis data dan server utama berada di Indonesia. Bila data diproses penyedia di luar Indonesia, kami memastikan tingkat pelindungan yang setara atau lebih tinggi sesuai UU PDP. Data dikirim lewat koneksi terenkripsi (TLS). Token akses marketplace dienkripsi. Akses dibatasi menurut peran, per toko, dan per gudang. Perubahan penting tercatat di log audit.</p>`,
        },
        {
          id: "masa-simpan",
          title: "Berapa lama data disimpan",
          body: html`<ul>
<li>Data akun dan bisnis disimpan selama akun aktif, lalu dihapus dalam ${site.legal.deletionDays} hari setelah akun ditutup, kecuali yang wajib disimpan menurut hukum.</li>
<li>Data pembeli disimpan selama diperlukan untuk pesanan, retur, dan pencatatan, lalu dianonimkan paling lama 2 tahun setelah pesanan. Saat Anda memutus toko tanpa menyimpan datanya, data toko itu dihapus.</li>
<li>Tagihan dan catatan perpajakan disimpan selama diwajibkan peraturan perpajakan.</li>
</ul>`,
        },
        {
          id: "hak",
          title: "Hak Anda",
          body: html`<p>Menurut UU PDP, Anda berhak mendapat informasi tentang pemrosesan, mengakses dan mendapat salinan data, memperbaiki data yang keliru, meminta penghapusan, menarik persetujuan, dan mengajukan keberatan. Sampaikan permintaan ke <a href="mailto:${site.contact.privacyEmail}">${site.contact.privacyEmail}</a>; kami menanggapinya dalam jangka waktu yang ditetapkan UU PDP. Pembeli yang datanya diproses lewat toko Anda dapat mengajukan permintaan kepada Anda sebagai penjual, dan kami membantu Anda memenuhinya.</p>`,
        },
        {
          id: "cookie",
          title: "Cookie",
          body: html`<p>Aplikasi OmniSeller memakai cookie sesi yang diperlukan agar Anda tetap masuk. Situs ini tidak memakai cookie, analitik, atau pelacak pihak ketiga.</p>`,
        },
        {
          id: "insiden",
          title: "Kegagalan pelindungan data",
          body: html`<p>Bila terjadi kegagalan pelindungan data pribadi, kami memberi tahu Anda dan pihak berwenang paling lambat 3 x 24 jam sejak mengetahuinya, sesuai UU PDP, beserta data yang terdampak dan langkah yang diambil.</p>`,
        },
        {
          id: "anak",
          title: "Anak-anak",
          body: html`<p>OmniSeller adalah layanan untuk pelaku usaha dan tidak ditujukan bagi anak-anak.</p>`,
        },
        {
          id: "perubahan",
          title: "Perubahan kebijakan",
          body: html`<p>Perubahan kebijakan ini diberitahukan lewat email dan di dalam aplikasi paling lambat ${site.legal.changeNoticeDays} hari sebelum berlaku.</p>`,
        },
        {
          id: "kontak",
          title: "Kontak pelindungan data",
          body: html`<p>${c.legalName}<br>${c.address}<br>Email <a href="mailto:${site.contact.privacyEmail}">${site.contact.privacyEmail}</a></p>`,
        },
      ],
    });
  },
};
