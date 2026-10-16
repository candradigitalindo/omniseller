import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

// Documentation is input data only. The snapshot is downloaded separately; this tool executes no
// third-party code and sends no requests to a marketplace or seller account.
const repoRoot = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!["--snapshot", "--output-dir", "--snapshot-source"].includes(args[i]) || !args[i + 1]) {
    throw new Error("Usage: pnpm audit:shopee --snapshot <snapshot/shopee> [--output-dir <directory>]");
  }
  options.set(args[i], args[i] === "--snapshot-source" ? args[i + 1] : path.resolve(args[i + 1]));
}
const snapshot = options.get("--snapshot");
if (!snapshot) throw new Error("--snapshot is required; see packages/connectors/shopee/README.md");
const output = options.get("--output-dir") ?? repoRoot;
const source =
  options.get("--snapshot-source") ?? "Provenance snapshot tidak dinyatakan; cocokkan metadata tiap baris.";
const references = new Map();
const directory = path.join(repoRoot, "backend/packages/connectors/shopee/src");
for (const file of (await readdir(directory)).sort()) {
  if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
  const filename = path.join(directory, file);
  const document = ts.createSourceFile(filename, await readFile(filename, "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isStringLiteralLike(node) && node.text.startsWith("/api/v2/")) {
      const endpoint = node.text;
      const line = document.getLineAndCharacterOfPosition(node.getStart(document)).line + 1;
      const evidence = `${path.relative(repoRoot, filename).split(path.sep).join("/")}:${line}`;
      if (!references.has(endpoint)) references.set(endpoint, []);
      references.get(endpoint).push(evidence);
    }
    ts.forEachChild(node, visit);
  }
  visit(document);
}

const flows = {
  public: ["Otorisasi dan refresh token", "backend/src/modules/channel/credential.service.ts", "/integrasi"],
  auth: ["Otorisasi dan refresh token", "backend/src/modules/channel/store-authorization.service.ts", "/integrasi"],
  shop: ["Profil toko dan pemetaan gudang", "backend/src/modules/channel/stores.service.ts", "/integrasi"],
  product: [
    "Katalog, stok dan salin listing; bukan seluruh operasi Product",
    "backend/src/modules/catalog; backend/src/modules/inventory; backend/src/modules/listing-copy",
    "/produk; /listing; /stok; /listing/salin",
  ],
  logistics: ["Pengiriman, resi, label dan pelacakan", "backend/src/modules/fulfillment", "/pengiriman; /pesanan"],
  order: ["Sinkronisasi pesanan dan pembatalan", "backend/src/modules/orders", "/pesanan; /retur"],
  returns: ["Retur dan tanggapan penjual", "backend/src/modules/returns", "/retur"],
  media_space: ["Upload gambar untuk salin listing", "backend/src/modules/listing-copy", "/listing/salin"],
  push: [
    "Konfigurasi push dan penerimaan webhook",
    "backend/src/modules/sync; backend/src/modules/channel",
    "Konsol Shopee dan sinkronisasi latar belakang",
  ],
};
const apiRows = [];
const catalogPaths = new Set();
const metadataFiles = (await readdir(path.join(snapshot, "api-reference")))
  .filter((file) => file.endsWith(".metadata.json"))
  .sort();
for (const file of metadataFiles) {
  const metadata = JSON.parse(await readFile(path.join(snapshot, "api-reference", file), "utf8"));
  const detail = JSON.parse(
    await readFile(path.join(snapshot, "api-reference", file.replace(".metadata.json", ".structured.json")), "utf8"),
  );
  const sections = detail.sections ?? [];
  const address = sections.find((section) => section.title === "Request Address");
  const paths = new Set();
  for (const match of (address?.text ?? "").matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    const pathname = new URL(match[0]).pathname;
    if (pathname.startsWith("/api/v2/")) paths.add(pathname);
  }
  for (const pathname of paths) catalogPaths.add(pathname);
  const evidence = [...paths].flatMap((pathname) => references.get(pathname) ?? []);
  const module = metadata.title?.split(".")[1] ?? "unknown";
  const examples = sections.find((section) => section.title === "Request Example")?.text ?? "";
  const method = /(?:--request\s+|CUSTOMREQUEST\s*=>\s*')GET\b|Unirest\.get\(/i.test(examples)
    ? "GET"
    : /(?:--request\s+|CUSTOMREQUEST\s*=>\s*')POST\b|Unirest\.post\(/i.test(examples)
      ? "POST"
      : "Perlu verifikasi";
  const permission =
    sections
      .find((section) => section.title === "API Permissions")
      ?.text.replace(/^API Permissions\s*(?:Collapse|More)?\s*APP types that can call this API\.?\s*/i, "")
      .trim() ?? "Tidak tercatat";
  const flow = evidence.length > 0 ? flows[module] : undefined;
  const isAms = evidence.length > 0 && module === "ams";
  apiRows.push({
    api: metadata.title,
    module: metadata.category ?? module,
    method,
    path: [...paths].join("; "),
    connector: evidence.length > 0 ? "Ada referensi kode" : "Belum ada referensi kode",
    evidence: evidence.join("; "),
    application: isAms
      ? "Adapter baca saja; belum ada service/job/API/UI pemakai"
      : (flow?.[0] ?? "Belum dipetakan ke alur aplikasi"),
    backend: flow?.[1] ?? "",
    ui: flow?.[2] ?? "",
    app_permissions_snapshot: permission,
    official_url: metadata.url,
    snapshot_crawled_at: metadata.crawledAt ?? "",
    snapshot_validation: `${metadata.status}; failures=${metadata.validation?.failed ?? "unknown"}`,
    verification: "Sumber sekunder; belum dicocokkan ke portal resmi terkini atau sandbox nyata",
  });
}

const guideRows = [];
for (const file of (await readdir(path.join(snapshot, "developer-guide")))
  .filter((name) => name.endsWith(".metadata.json"))
  .sort()) {
  const metadata = JSON.parse(await readFile(path.join(snapshot, "developer-guide", file), "utf8"));
  const detail = JSON.parse(
    await readFile(path.join(snapshot, "developer-guide", file.replace(".metadata.json", ".structured.json")), "utf8"),
  );
  guideRows.push({
    title: metadata.title,
    category: metadata.category,
    official_url: metadata.url,
    last_updated: metadata.lastUpdated ?? "",
    snapshot_crawled_at: metadata.crawledAt,
    headings: (detail.headings ?? []).join("; "),
    verification: "Terinventarisasi dari snapshot sekunder; bukan bukti seluruh ketentuan telah dipenuhi",
  });
}

function csv(rows) {
  const fields = Object.keys(rows[0] ?? {});
  const cell = (value) => {
    const text = String(value ?? "");
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return `\uFEFF${[fields, ...rows.map((row) => fields.map((field) => row[field]))].map((row) => row.map(cell).join(",")).join("\n")}\n`;
}
const modules = new Map();
for (const row of apiRows) {
  const counts = modules.get(row.module) ?? { total: 0, referenced: 0 };
  counts.total += 1;
  if (row.evidence) counts.referenced += 1;
  modules.set(row.module, counts);
}
const unmatched = [...references.keys()].filter((pathname) => !catalogPaths.has(pathname)).sort();
const referenced = apiRows.filter((row) => row.evidence).length;
const dates = [...new Set(apiRows.map((row) => row.snapshot_crawled_at.slice(0, 10)))].sort().join(", ");
const summary = `# Cakupan endpoint Shopee — hasil inventaris\n\nSumber sekunder: ${source}. Tanggal snapshot: ${dates}; portal resmi tidak dapat diakses dari lingkungan audit (HTTP 403).\n\n${apiRows.length} endpoint dokumentasi, ${modules.size} modul, ${guideRows.length} panduan. ${referenced} endpoint dokumentasi memiliki referensi literal pada connector; ${apiRows.length - referenced} belum memiliki referensi. Jumlah path unik kode adalah ${references.size}. Angka tersebut mengukur referensi kode, bukan fitur lengkap atau keberhasilan sandbox.\n\n| Modul | Endpoint snapshot | Ada referensi connector | Belum ada referensi |\n|---|---:|---:|---:|\n${[...modules].map(([name, count]) => `| ${name} | ${count.total} | ${count.referenced} | ${count.total - count.referenced} |`).join("\n")}\n\nPath kode yang belum ditemukan dalam snapshot:\n${unmatched.length ? unmatched.map((pathname) => `- \`${pathname}\``).join("\n") : "Tidak ada."}\n\nDeteksi menggunakan AST TypeScript pada berkas produksi connector; komentar dan berkas tes tidak dihitung. Pemanggilan dinamis yang tidak berupa string literal membutuhkan tinjauan terpisah. Alur backend/UI dicantumkan pada level domain dan harus ditinjau per operasi; nama halaman tidak membuktikan seluruh endpoint domain sudah digunakan. Tidak ada klaim kesetaraan terhadap seluruh katalog Shopee terkini.\n`;
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "AUDIT-SHOPEE-ENDPOINTS.csv"), csv(apiRows));
await writeFile(path.join(output, "AUDIT-SHOPEE-GUIDES.csv"), csv(guideRows));
await writeFile(path.join(output, "AUDIT-SHOPEE-RINGKASAN.md"), summary);
console.log(
  JSON.stringify(
    {
      endpoints: apiRows.length,
      modules: modules.size,
      guides: guideRows.length,
      referenced,
      missing: apiRows.length - referenced,
      sourcePaths: references.size,
      unmatched,
    },
    null,
    2,
  ),
);
