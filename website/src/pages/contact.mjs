import { html } from "../html.mjs";
import { whatsappLink } from "../layout.mjs";

export default {
  path: "/kontak/",
  title: "Kontak",
  description: "Hubungi OmniSeller lewat email atau WhatsApp: pertanyaan, dukungan, tagihan, pengaduan, dan urusan data pribadi.",
  body: (site) => html`<section class="section page-head">
  <div class="wrap">
    <h1>Kontak</h1>
    <p class="lead">Pertanyaan sebelum mendaftar, bantuan memakai OmniSeller, tagihan, atau pengaduan: hubungi kami lewat salah satu jalur di bawah.</p>
  </div>
</section>

<section class="section" aria-label="Jalur kontak">
  <div class="wrap">
    <div class="cards three">
      <div class="card">
        <h2>Email</h2>
        <p><a href="mailto:${site.contact.email}">${site.contact.email}</a></p>
        <p class="muted">Untuk pertanyaan, dukungan, tagihan, dan pengaduan.</p>
      </div>
      <div class="card">
        <h2>WhatsApp</h2>
        <p><a href="${whatsappLink(site)}">+${site.contact.whatsapp}</a></p>
        <p class="muted">${site.contact.hours}.</p>
      </div>
      <div class="card">
        <h2>Data pribadi</h2>
        <p><a href="mailto:${site.contact.privacyEmail}">${site.contact.privacyEmail}</a></p>
        <p class="muted">Permintaan akses, perbaikan, atau penghapusan data, sesuai <a href="/kebijakan-privasi/">Kebijakan Privasi</a>.</p>
      </div>
    </div>
  </div>
</section>

<section class="section alt" aria-labelledby="pengaduan">
  <div class="wrap narrow">
    <h2 id="pengaduan">Layanan pengaduan</h2>
    <p>Kirim pengaduan ke <a href="mailto:${site.contact.email}">${site.contact.email}</a> dengan nama bisnis, email akun, dan, bila menyangkut tagihan, nomor tagihan (INV-...). Kami menjawab paling lambat satu hari kerja dan memberi tahu perkembangannya sampai selesai.</p>
    <h2>Pengelola</h2>
    <p><strong>${site.company.legalName}</strong><br>${site.company.address}<br>NIB ${site.company.nib} · NPWP ${site.company.npwp}</p>
  </div>
</section>`,
};
