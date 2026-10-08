#!/usr/bin/env node
/**
 * The public site (technology doc ADR-041): one HTML file per page in src/pages, the stylesheet and icon
 * from src/assets, robots.txt, and sitemap.xml, written to dist/. Business details come from site.json.
 * Text still marked "[ISI: ...]" is listed; with --strict the build fails, so a site that still has them
 * is never published. No dependencies: Node 22 or newer.
 *
 *   node build.mjs [--strict] [--out <dir>] [--site <file>]
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLACEHOLDER } from "./src/html.mjs";
import { page } from "./src/layout.mjs";
import contact from "./src/pages/contact.mjs";
import home from "./src/pages/home.mjs";
import notFound from "./src/pages/not-found.mjs";
import pricing from "./src/pages/pricing.mjs";
import privacy from "./src/pages/privacy.mjs";
import refund from "./src/pages/refund.mjs";
import terms from "./src/pages/terms.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PAGES = [home, pricing, contact, terms, privacy, refund, notFound];

/** Where a page's path lands: "/" is index.html, "/harga/" is harga/index.html, "/404.html" itself. */
export function fileFor(path) {
  if (path.endsWith(".html")) return path.slice(1);
  return join(path.slice(1), "index.html");
}

export function loadSite(file = join(HERE, "site.json")) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Builds the site into `out`; returns the files written and the placeholders still in them. */
export function build({ site, out }) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const written = [];
  const placeholders = new Set();
  const write = (name, text) => {
    const file = join(out, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    written.push(name);
    for (const m of text.match(PLACEHOLDER) ?? []) placeholders.add(m);
  };
  for (const p of PAGES) write(fileFor(p.path), page(site, { ...p, body: p.body(site) }));
  cpSync(join(HERE, "src/assets"), out, { recursive: true });
  written.push("style.css", "favicon.svg");
  const base = site.url.replace(/\/+$/, "");
  const listed = PAGES.filter((p) => !p.path.endsWith(".html"));
  write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
  write(
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${listed
      .map((p) => `  <url><loc>${base}${p.path}</loc></url>`)
      .join("\n")}\n</urlset>\n`,
  );
  return { written, placeholders: [...placeholders].sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const out = resolve(option("--out", join(HERE, "dist")));
  const { written, placeholders } = build({ site: loadSite(resolve(option("--site", join(HERE, "site.json")))), out });
  console.log(`${written.length} files in ${out}`);
  if (placeholders.length) {
    console.log(`\nStill to fill in site.json (${placeholders.length}):`);
    for (const p of placeholders) console.log(`  ${p}`);
    if (args.includes("--strict")) {
      console.error("\n--strict: not publishable until every [ISI: ...] is filled in.");
      process.exit(1);
    }
  }
}
