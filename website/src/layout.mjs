import { html, raw } from "./html.mjs";

/** The OmniSeller mark, as in the web app (frontend/src/app/icon.svg). */
export const LOGO = raw(
  '<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="8" fill="#1e6b8c"/><circle cx="16" cy="16" r="8" fill="none" stroke="#fff" stroke-width="3.5"/><circle cx="22.5" cy="9.5" r="2.5" fill="#fff"/></svg>',
);

export const NAV = [
  { href: "/#fitur", label: "Fitur" },
  { href: "/harga/", label: "Harga" },
  { href: "/kontak/", label: "Kontak" },
];

export const LEGAL = [
  { href: "/syarat-layanan/", label: "Syarat Layanan" },
  { href: "/kebijakan-privasi/", label: "Kebijakan Privasi" },
  { href: "/kebijakan-pengembalian-dana/", label: "Kebijakan Pengembalian Dana" },
];

const trim = (url) => url.replace(/\/+$/, "");

/** The app's own pages (sign up, sign in), from `appUrl`. */
export const appLink = (site, path) => `${trim(site.appUrl)}${path}`;

export const whatsappLink = (site) => `https://wa.me/${site.contact.whatsapp}`;

/** One whole page: head, header with the menu, the page's own content, and the footer every page shares. */
export function page(site, { path, title, description, body }) {
  const full = path === "/" ? `${site.brand}: ${title}` : `${title} | ${site.brand}`;
  const canonical = `${trim(site.url)}${path}`;
  const year = new Date().getFullYear();
  const c = site.company;
  return `<!doctype html>
${html`<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${full}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${site.brand}">
<meta property="og:locale" content="id_ID">
<meta property="og:title" content="${full}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
<meta name="theme-color" content="#1e6b8c">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<a class="skip" href="#isi">Langsung ke isi</a>
<header class="site-header">
  <div class="wrap header-row">
    <a class="brand" href="/">${LOGO}<span>${site.brand}</span></a>
    <nav class="nav" aria-label="Menu utama">
      <ul>${NAV.map(
        (n) => html`<li><a href="${n.href}"${n.href === path ? raw(' aria-current="page"') : ""}>${n.label}</a></li>`,
      )}</ul>
    </nav>
    <div class="header-actions">
      <a class="button ghost" href="${appLink(site, "/masuk")}">Masuk</a>
      <a class="button" href="${appLink(site, "/daftar")}">Coba gratis</a>
    </div>
  </div>
</header>
<main id="isi">
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-grid">
    <div class="footer-about">
      <p class="brand">${LOGO}<span>${site.brand}</span></p>
      <p>Dikelola oleh ${c.legalName}.<br>${c.address}</p>
      <p>NIB ${c.nib}<br>NPWP ${c.npwp}</p>
    </div>
    <nav aria-label="Produk">
      <h2 class="footer-title">Produk</h2>
      <ul>
        <li><a href="/#fitur">Fitur</a></li>
        <li><a href="/harga/">Harga</a></li>
        <li><a href="${appLink(site, "/daftar")}">Daftar</a></li>
        <li><a href="${appLink(site, "/masuk")}">Masuk</a></li>
      </ul>
    </nav>
    <nav aria-label="Kebijakan">
      <h2 class="footer-title">Kebijakan</h2>
      <ul>${LEGAL.map((l) => html`<li><a href="${l.href}"${l.href === path ? raw(' aria-current="page"') : ""}>${l.label}</a></li>`)}</ul>
    </nav>
    <div>
      <h2 class="footer-title">Hubungi kami</h2>
      <ul>
        <li><a href="mailto:${site.contact.email}">${site.contact.email}</a></li>
        <li><a href="${whatsappLink(site)}">WhatsApp +${site.contact.whatsapp}</a></li>
        <li><a href="/kontak/">Kontak dan pengaduan</a></li>
      </ul>
      <p class="muted">${site.contact.hours}</p>
    </div>
  </div>
  <div class="wrap footer-bottom">
    <p>© ${year} ${c.legalName}. Shopee dan Tokopedia &amp; Shop adalah merek milik pemiliknya masing-masing.</p>
  </div>
</footer>
</body>
</html>`}
`;
}
