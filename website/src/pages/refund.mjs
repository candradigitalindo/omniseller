import { html } from "../html.mjs";
import { legalBody } from "../legal.mjs";

/**
 * Kebijakan Pengembalian Dana: the billing rules of backend doc 8.32 as a customer reads them. Money that
 * arrives for an invoice no longer in force is recorded and handled by support; nothing else is refunded.
 */
export default {
  path: "/kebijakan-pengembalian-dana/",
  title: "Kebijakan Pengembalian Dana",
  description:
    "Kebijakan Pengembalian Dana OmniSeller: kapan pembayaran langganan dikembalikan, cara mengajukan, dan berapa lama prosesnya.",
  body: (site) => {
    const l = site.legal;
    return legalBody(site, {
      title: "Kebijakan Pengembalian Dana",
      summary: html`<p>Ringkasnya: uji coba gratis, langganan dibayar per bulan di muka, dan periode yang sudah berjalan tidak dikembalikan. Uang dikembalikan untuk pembayaran ganda, pembayaran atas tagihan yang sudah tidak berlaku, dan kesalahan tagihan dari kami.</p>`,
      sections: [
        {
          id: "uji-coba",
          title: "Uji coba",
          body: html`<p>Uji coba ${site.pricing.trialDays} hari tidak dipungut biaya. Bila Anda tidak berlangganan, bisnis kembali ke paket Starter tanpa tagihan apa pun.</p>`,
        },
        {
          id: "periode",
          title: "Periode yang sudah dibayar",
          body: html`<p>Langganan dibayar per bulan di muka. Biaya periode yang sudah berjalan tidak dikembalikan, termasuk saat Anda berhenti atau turun paket di tengah periode; paket tetap aktif sampai periode itu berakhir. Saat naik paket, sisa periode yang sudah dibayar dipotong dari tagihan paket baru, bukan dikembalikan sebagai uang.</p>`,
        },
        {
          id: "dikembalikan",
          title: "Kapan dana dikembalikan",
          body: html`<ul>
<li><strong>Pembayaran ganda:</strong> tagihan yang sama dibayar lebih dari sekali.</li>
<li><strong>Tagihan yang sudah tidak berlaku:</strong> pembayaran yang masuk untuk tagihan yang sudah dibatalkan atau kedaluwarsa. Pembayaran ini tercatat, Anda diberi tahu di aplikasi, dan dananya dikembalikan setelah Anda mengajukannya.</li>
<li><strong>Kesalahan tagihan dari kami:</strong> jumlah yang ditagih tidak sesuai harga atau aturan di halaman <a href="/harga/">Harga</a>. Selisihnya dikembalikan.</li>
</ul>
<p>Untuk paket Business dengan lampiran jaminan tingkat layanan, kompensasi gangguan diberikan sebagai kredit layanan sesuai lampiran itu.</p>`,
        },
        {
          id: "cara",
          title: "Cara mengajukan",
          body: html`<p>Kirim email ke <a href="mailto:${site.contact.email}">${site.contact.email}</a> paling lambat ${l.refundRequestDays} hari setelah pembayaran, berisi nama bisnis, email akun, nomor tagihan (INV-...), bukti pembayaran, alasan, dan rekening tujuan atas nama bisnis atau pemiliknya.</p>`,
        },
        {
          id: "proses",
          title: "Proses dan waktu",
          body: html`<p>Kami memeriksa permintaan dalam ${l.refundReviewDays} hari kerja dan memberi tahu hasilnya lewat email. Pengembalian yang disetujui dikirim dalam ${l.refundPayoutDays} hari kerja ke rekening yang Anda sebutkan, sebesar jumlah yang memenuhi syarat di atas.</p>`,
        },
        {
          id: "kontak",
          title: "Kontak",
          body: html`<p>${site.company.legalName}<br>Email <a href="mailto:${site.contact.email}">${site.contact.email}</a><br>WhatsApp +${site.contact.whatsapp}</p>`,
        },
      ],
    });
  },
};
