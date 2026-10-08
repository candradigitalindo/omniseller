import { html } from "../html.mjs";

/** Served by the host for any unknown address (`404.html`). */
export default {
  path: "/404.html",
  title: "Halaman tidak ditemukan",
  description: "Halaman yang Anda cari tidak ada di situs OmniSeller.",
  body: () => html`<section class="section page-head">
  <div class="wrap narrow">
    <h1>Halaman tidak ditemukan</h1>
    <p class="lead">Alamat ini tidak ada atau sudah dipindahkan.</p>
    <div class="actions"><a class="button" href="/">Ke beranda</a><a class="button ghost" href="/harga/">Lihat harga</a></div>
  </div>
</section>`,
};
