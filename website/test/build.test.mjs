import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build, fileFor, loadSite, PAGES } from "../build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const real = loadSite();
/** site.json with every [ISI: ...] filled in, as a business would before publishing. */
const filled = loadSite(join(HERE, "filled-site.json"));

function built(site) {
  const out = mkdtempSync(join(tmpdir(), "omniseller-site-"));
  return { out, ...build({ site, out }) };
}
const read = (out, name) => readFileSync(join(out, name), "utf8");
/** The policies every page links to: written here, not read from the layout under test. */
const POLICIES = ["/syarat-layanan/", "/kebijakan-privasi/", "/kebijakan-pengembalian-dana/"];
const pages = (out) => PAGES.map((p) => ({ path: p.path, html: read(out, fileFor(p.path)) }));
const hrefs = (html) => [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1]);

test("writes every page, the stylesheet, the icon, robots.txt, and sitemap.xml", () => {
  const { out, written } = built(filled);
  for (const name of [
    "index.html",
    "harga/index.html",
    "kontak/index.html",
    "syarat-layanan/index.html",
    "kebijakan-privasi/index.html",
    "kebijakan-pengembalian-dana/index.html",
    "404.html",
    "style.css",
    "favicon.svg",
    "robots.txt",
    "sitemap.xml",
  ]) {
    assert.ok(existsSync(join(out, name)), name);
    assert.ok(written.includes(name), name);
  }
  const sitemap = read(out, "sitemap.xml");
  assert.match(sitemap, /<loc>https:\/\/omniseller\.example\/harga\/<\/loc>/);
  assert.doesNotMatch(sitemap, /404/);
  assert.match(read(out, "robots.txt"), /Sitemap: https:\/\/omniseller\.example\/sitemap\.xml/);
});

test("every page is a whole Indonesian page with one heading, the menu, and the policies in its footer", () => {
  const { out } = built(filled);
  for (const { path, html } of pages(out)) {
    assert.match(html, /^<!doctype html>\n<html lang="id">/, path);
    assert.match(html, /<title>[^<]*OmniSeller[^<]*<\/title>/, path);
    assert.match(html, /<meta name="description" content="[^"]{40,}">/, path);
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1, `${path}: one h1`);
    assert.match(html, /<a class="skip" href="#isi">/, path);
    assert.doesNotMatch(html, /&(?![a-z]+;|#\d+;)/i, `${path}: a bare & in the markup`);
    assert.match(html, /<main id="isi">/, path);
    for (const href of POLICIES) assert.ok(html.includes(`href="${href}"`), `${path} links ${href}`);
    assert.ok(html.includes('href="/kontak/"'), `${path} links the contact page`);
  }
  // the page in view is marked in the menu or the footer
  assert.match(read(out, "harga/index.html"), /<a href="\/harga\/" aria-current="page">Harga<\/a>/);
});

test("links between pages all lead to a built file", () => {
  const { out } = built(filled);
  for (const { path, html } of pages(out)) {
    for (const href of hrefs(html).filter((h) => h.startsWith("/"))) {
      const target = href.split("#")[0];
      const file = target.endsWith("/") ? join(target.slice(1), "index.html") : target.slice(1) || "index.html";
      assert.ok(existsSync(join(out, file)), `${path}: ${href}`);
    }
    for (const anchor of hrefs(html).filter((h) => h.startsWith("#"))) {
      assert.ok(html.includes(`id="${anchor.slice(1)}"`), `${path}: ${anchor}`);
    }
  }
});

test("loads nothing from other sites: no scripts, fonts, or trackers", () => {
  const { out } = built(filled);
  const allowed = [filled.url, filled.appUrl, "https://wa.me/", "mailto:"];
  for (const { path, html } of pages(out)) {
    assert.doesNotMatch(html, /<script/i, path);
    for (const href of hrefs(html).filter((h) => /^[a-z]+:/i.test(h))) {
      assert.ok(
        allowed.some((a) => href.startsWith(a)),
        `${path}: ${href}`,
      );
    }
  }
  assert.doesNotMatch(read(out, "style.css"), /url\(|@import/);
});

test("prices, quotas, and extra features are the plans the backend seeds and enforces", () => {
  const seed = readFileSync(join(ROOT, "../backend/drizzle/sql/90_seeds.sql"), "utf8");
  // the features the backend checks, with the names it gives them (backend doc 8.33)
  const enforced = new Map(
    [
      ...(/export const PLAN_FEATURES = \{([^}]*)\}/.exec(
        readFileSync(join(ROOT, "../backend/src/common/plan-features.ts"), "utf8"),
      )?.[1] ?? "").matchAll(/(\w+): "([^"]+)"/g),
    ].map((m) => [m[1], m[2]]),
  );
  assert.ok(enforced.size > 0);
  const rows = [
    ...seed.matchAll(/\(gen_ulid\(\), '(\w+)', '([^']+)',\s*'(\{[^']*\})',\s*'\{([^']*)\}', (\d+)\)/g),
  ].map((m) => {
    const l = JSON.parse(m[3]);
    const features = m[4].split(",").map((f) => f.trim());
    return {
      code: m[1],
      name: m[2],
      priceMonthly: Number(m[5]),
      limits: { stores: l.stores, warehouses: l.warehouses, ordersPerMonth: l.orders_per_month, users: l.users },
      // only what the backend enforces is promised; the rest of the seed list is not built yet
      extras: features.filter((f) => enforced.has(f)).map((f) => enforced.get(f)),
    };
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(
    real.plans.map(({ code, name, priceMonthly, limits, extras }) => ({ code, name, priceMonthly, limits, extras })),
    rows,
  );
  assert.deepEqual(filled.plans, real.plans);
});

test("trial, grace, and renewal days are the backend's own", () => {
  const plan = readFileSync(join(ROOT, "../backend/src/modules/billing/billing-plan.ts"), "utf8");
  const constant = (name) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(plan)?.[1]);
  assert.equal(real.pricing.trialDays, constant("TRIAL_DAYS"));
  assert.equal(real.pricing.graceDays, constant("GRACE_DAYS"));
  assert.equal(real.pricing.renewalNoticeDays, constant("RENEWAL_NOTICE_DAYS"));
  // the longest the business may keep buyer data is what the privacy policy promises (backend doc 8.34)
  const business = readFileSync(join(ROOT, "../backend/src/modules/business/business-plan.ts"), "utf8");
  const months = Number(/export const DEFAULT_BUYER_DATA_RETENTION_MONTHS = (\d+);/.exec(business)?.[1]);
  assert.equal(real.legal.buyerDataMonths, months);
  assert.equal(filled.legal.buyerDataMonths, months);
  assert.deepEqual(filled.pricing, { ...real.pricing, taxNote: filled.pricing.taxNote });
});

test("the pricing page states each plan's price, quotas, trial, and grace days", () => {
  const { out } = built(filled);
  const html = read(out, "harga/index.html");
  for (const text of [
    "Gratis",
    "Rp 899.000",
    "Rp 2.499.000",
    "1.000 pesanan per bulan",
    "10.000 pesanan per bulan",
    "100.000 pesanan per bulan",
    "Toko marketplace tidak dibatasi",
    "Peran kustom",
    "Laporan kinerja staf",
    "uji coba 14 hari",
    "paket tetap aktif 7 hari",
    "Harga sudah termasuk PPN.",
  ]) {
    assert.ok(html.includes(text), text);
  }
});

test("names the channel Tokopedia &amp; Shop and never TikTok", () => {
  const { out } = built(filled);
  for (const { path, html } of pages(out)) assert.doesNotMatch(html, /tiktok/i, path);
  assert.ok(read(out, "index.html").includes("Tokopedia &#38; Shop") || read(out, "index.html").includes("Tokopedia &amp; Shop"));
});

test("escapes the business's details, so no name can break a page", () => {
  const { out } = built({ ...filled, company: { ...filled.company, legalName: 'PT "A" & B <Toko>' } });
  const html = read(out, "kontak/index.html");
  assert.ok(html.includes("PT &#34;A&#34; &#38; B &#60;Toko&#62;"));
  assert.doesNotMatch(html, /<Toko>/);
});

test("the pages carry the business's own figures, never ones written into them", () => {
  // figures unlike the real ones, so a number typed into a template shows
  const site = {
    ...filled,
    pricing: { ...filled.pricing, trialDays: 21, graceDays: 5, renewalNoticeDays: 6 },
    legal: {
      ...filled.legal,
      changeNoticeDays: 15,
      disputeDays: 40,
      refundRequestDays: 45,
      refundReviewDays: 4,
      refundPayoutDays: 9,
      deletionDays: 60,
      buyerDataMonths: 13,
    },
  };
  const { out } = built(site);
  const refund = read(out, "kebijakan-pengembalian-dana/index.html");
  assert.ok(refund.includes("paling lambat 45 hari setelah pembayaran"));
  assert.ok(refund.includes("dalam 4 hari kerja"));
  assert.ok(refund.includes("dikirim dalam 9 hari kerja"));
  assert.ok(refund.includes("Uji coba 21 hari"));
  const terms = read(out, "syarat-layanan/index.html");
  assert.ok(terms.includes("dalam 60 hari"));
  assert.ok(terms.includes("uji coba 21 hari"));
  assert.ok(terms.includes("paket tetap aktif 5 hari"));
  assert.ok(terms.includes("dibuat 6 hari sebelum periode berakhir"));
  assert.ok(terms.includes("paling lambat 15 hari sebelum berlaku"));
  assert.ok(terms.includes("musyawarah dalam 40 hari"));
  assert.ok(terms.includes(filled.company.court));
  const pricing = read(out, "harga/index.html");
  assert.ok(pricing.includes("uji coba 21 hari") && pricing.includes("paket tetap aktif 5 hari"));
  assert.ok(read(out, "index.html").includes("Coba gratis 21 hari"));
  const privacy = read(out, "kebijakan-privasi/index.html");
  assert.ok(privacy.includes(`mailto:${filled.contact.privacyEmail}`));
  assert.ok(privacy.includes("dihapus dalam 60 hari"));
  assert.ok(privacy.includes("paling lambat 15 hari sebelum berlaku"));
  assert.ok(privacy.includes("paling lama 13 bulan setelah pesanan dibuat"));
  for (const html of [refund, terms, pricing, privacy]) assert.doesNotMatch(html, /\b(14|30|7) hari\b/);
});

test("lists what is left to fill in, and --strict refuses to publish it", () => {
  assert.equal(built(real).placeholders.length, 11);
  assert.deepEqual(built(filled).placeholders, []);
  const out = mkdtempSync(join(tmpdir(), "omniseller-site-"));
  const cli = (site) =>
    spawnSync(process.execPath, [join(ROOT, "build.mjs"), "--strict", "--out", out, "--site", site], {
      encoding: "utf8",
    });
  const refused = cli(join(ROOT, "site.json"));
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /\[ISI: nama badan usaha/);
  const fine = join(out, "..", `filled-${Date.now()}.json`);
  writeFileSync(fine, JSON.stringify(filled));
  assert.equal(cli(fine).status, 0);
});
