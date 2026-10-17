import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { restrictedNodeTransportMethod } from "./audit-http-evidence.mjs";

// Read an independently downloaded public documentation snapshot. Never execute downloaded code.
const root = path.resolve(import.meta.dirname, "../..");
const options = new Map();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!["--snapshot", "--output-dir"].includes(args[i]) || !args[i + 1])
    throw new Error("Usage: pnpm audit:tiktokshop --snapshot <directory> [--output-dir <directory>]");
  options.set(args[i], path.resolve(args[i + 1]));
}
const snapshot = options.get("--snapshot");
if (!snapshot) throw new Error("--snapshot is required; see packages/connectors/tiktokshop/README.md");
const output = options.get("--output-dir") ?? root;
const json = async (filename) => JSON.parse(await readFile(path.join(snapshot, filename), "utf8"));
const capture = await json("snapshot.json");
if (capture.issues.length) throw new Error("Snapshot has unresolved download failures");
const treeHash = createHash("sha256")
  .update(await readFile(path.join(snapshot, "tree.json")))
  .digest("hex");
if (treeHash !== capture.tree_sha256) throw new Error("Navigation tree checksum does not match snapshot metadata");
const tree = (await json("tree.json")).data.document_tree;
const nodes = new Map(tree.map((node) => [node.document_id, node]));
const details = new Map();
for (const file of (await readdir(path.join(snapshot, "details"))).sort()) {
  if (file.endsWith(".json")) {
    const detail = await json(`details/${file}`);
    details.set(detail.document_id, detail);
  }
}
for (const node of tree)
  if (!node.is_dir && !details.has(node.document_id)) throw new Error(`Missing document ${node.document_id}`);
const canonical = (value) => value.replace(/\{[^}]+\}/g, "{id}").replace(/\/$/, "");
function expand(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) return [...expand(node.whenTrue), ...expand(node.whenFalse)];
  if (ts.isParenthesizedExpression(node)) return expand(node.expression);
  if (!ts.isTemplateExpression(node)) return ["{id}"];
  let values = [node.head.text];
  for (const span of node.templateSpans)
    values = values.flatMap((prefix) => expand(span.expression).map((part) => prefix + part + span.literal.text));
  return values;
}
const helpers = new Map([
  ["get", "GET"],
  ["post", "POST"],
  ["token", "GET"],
  ["upload", "POST"],
]);
const callMethod = (call) =>
  helpers.get(ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : call.expression.getText());

function methodOf(node, document) {
  for (let current = node; current; current = current.parent) {
    if (ts.isObjectLiteralExpression(current)) {
      const method = current.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === "method");
      if (method && ts.isStringLiteralLike(method.initializer)) return method.initializer.text;
    }
    if (ts.isCallExpression(current) && callMethod(current)) return callMethod(current);
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      const methods = new Set();
      const variable = current.name.text;
      function findUse(child) {
        if (
          ts.isPropertyAssignment(child) &&
          ts.isIdentifier(child.initializer) &&
          child.initializer.text === variable &&
          ["path", "endpoint"].includes(child.name.getText())
        ) {
          const object = child.parent;
          if (ts.isObjectLiteralExpression(object)) {
            const method = object.properties.find(
              (property) => ts.isPropertyAssignment(property) && property.name.getText() === "method",
            );
            if (method && ts.isStringLiteralLike(method.initializer)) methods.add(method.initializer.text);
          }
        }
        if (
          ts.isCallExpression(child) &&
          child.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === variable)
        ) {
          const method = callMethod(child);
          if (method) methods.add(method);
        }
        ts.forEachChild(child, findUse);
      }
      findUse(document);
      if (methods.size === 1) return [...methods][0];
      const restricted = restrictedNodeTransportMethod(variable, document);
      if (restricted) return restricted;
    }
  }
  return "Perlu tinjauan";
}
const references = new Map();
const dir = path.join(root, "backend/packages/connectors/tiktokshop/src");
for (const file of (await readdir(dir)).sort()) {
  // Generated operation, scope and outcome catalogues are declarations, not call evidence.
  if (!file.endsWith(".ts") || file.endsWith(".spec.ts") || file.endsWith("-contracts.ts")) continue;
  const filename = path.join(dir, file);
  const document = ts.createSourceFile(filename, await readFile(filename, "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    // Observer callbacks only describe/redact transport records; their paths are logging metadata.
    if (ts.isPropertyAssignment(node) && node.name.getText() === "observer") return;
    // Upload target metadata does not prove that the future business call was performed.
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) => ts.isPropertyAssignment(property) && property.name.getText() === "operationId",
      ) &&
      node.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText() === "binding")
    )
      return;
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      for (const endpoint of expand(node)) {
        if (!/^\/(?:api\/v2\/|[a-z_]+\/\d{6}\/)/.test(endpoint)) continue;
        const method = methodOf(node, document);
        const line = document.getLineAndCharacterOfPosition(node.getStart(document)).line + 1;
        const evidence = `${path.relative(root, filename).split(path.sep).join("/")}:${line}`;
        const key = `${method} ${canonical(endpoint)}`;
        if (!references.has(key)) references.set(key, new Set());
        references.get(key).add(evidence);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(document);
}
function ancestry(id) {
  const names = [];
  const seen = new Set();
  while (nodes.has(id)) {
    if (seen.has(id)) throw new Error("Cyclic document tree");
    seen.add(id);
    const node = nodes.get(id);
    names.unshift(node.name);
    id = node.parent_id;
  }
  return names;
}
const officialUrl = (doc) => `https://partner.tiktokshop.com/docv2/page/${doc.document_path || doc.document_id}`;
const families = tree.filter((node) => !node.is_dir && node.is_api_doc && node.doc_type === 1);
const apiRows = [];
const matched = new Set();
const metaFiles = new Set(await readdir(path.join(snapshot, "api-meta")));
async function apiRow(detail, family, isCatalog, version) {
  const content = detail.content ?? "";
  const meta = metaFiles.has(`${detail.document_id}.json`)
    ? (await json(`api-meta/${detail.document_id}.json`)).document_api_meta
    : undefined;
  const endpoint = /^#\s*Path:\s*(\S+)/im.exec(content)?.[1] ?? meta?.interface_path;
  const method =
    /^#\s*Method:\s*\[?(GET|POST|PUT|DELETE|PATCH)\]?/im.exec(content)?.[1] ??
    /\bcurl\s+-X\s+(GET|POST|PUT|DELETE|PATCH)\b/.exec(
      meta?.sample_code?.find((sample) => sample.key === "curl")?.value ?? "",
    )?.[1];
  if (!endpoint || !method) throw new Error(`Missing explicit method/path for ${detail.document_id}`);
  const key = `${method} ${canonical(endpoint)}`;
  const evidence = [...(references.get(key) ?? [])];
  if (evidence.length) matched.add(key);
  if (meta?.interface_path && canonical(meta.interface_path) !== canonical(endpoint))
    throw new Error(`Metadata path mismatch for ${detail.document_id}`);
  apiRows.push({
    api: detail.title,
    module: ancestry(family.document_id)[1],
    version,
    method,
    path: endpoint,
    catalog_document_id: family.document_id,
    document_id: detail.document_id,
    catalog_default: isCatalog ? "Ya" : "Versi lain pada dropdown resmi",
    connector: evidence.length ? "Ada referensi kode; bukan bukti fitur lengkap" : "Belum ada referensi kode",
    evidence: evidence.join("; "),
    scope_keys:
      meta?.scope_list
        ?.map((s) => s.scope_key)
        .filter(Boolean)
        .join("; ") ?? "Perlu verifikasi",
    scope_names:
      meta?.scope_list
        ?.map((s) => s.package_name)
        .filter(Boolean)
        .join("; ") ?? "Perlu verifikasi",
    official_url: officialUrl({ ...detail, document_path: detail.redirect_document_path }),
    updated_at: new Date(Number(detail.update_time) * 1000).toISOString(),
    fetched_at: capture.fetched_at,
    verification: "Dokumen publik resmi; market, izin app/shop dan sandbox belum diverifikasi",
    contract_source: content ? "Markdown resmi" : "Metadata dan contoh cURL resmi; markdown kosong",
  });
}
for (const family of families) {
  const versions = (await json(`versions/${family.document_id}.json`)).api_external_list ?? [];
  const versionDocs = new Map(versions.map((v) => [v.external_doc_id, v.version]));
  if (!versionDocs.has(family.document_id)) versionDocs.set(family.document_id, "");
  for (const [id, version] of versionDocs) {
    if (!details.has(id)) throw new Error(`Missing version document ${id}`);
    await apiRow(details.get(id), family, id === family.document_id, version);
  }
}
// Token endpoints are documented inside the authorization guide rather than API Reference leaves.
const auth = [...details.values()].find((d) => d.document_id === "678e3a3292b0f40314a92d75");
for (const operation of ["get", "refresh"]) {
  const endpoint = `/api/v2/token/${operation}`;
  const url = `https://auth.tiktok-shops.com${endpoint}`;
  if (!auth?.content.includes(url)) throw new Error(`Token contract missing: ${endpoint}`);
  const key = `GET ${endpoint}`;
  const evidence = [...(references.get(key) ?? [])];
  if (evidence.length) matched.add(key);
  apiRows.push({
    api: operation === "get" ? "Get Access Token" : "Get Refresh Token",
    module: "Authorization (guide)",
    version: "v2",
    method: "GET",
    path: endpoint,
    catalog_document_id: "",
    document_id: auth.document_id,
    catalog_default: "Endpoint tertanam dalam panduan; di luar jumlah API Reference",
    connector: evidence.length ? "Ada referensi kode; bukan bukti fitur lengkap" : "Belum ada referensi kode",
    evidence: evidence.join("; "),
    scope_keys: "Authorization flow",
    scope_names: "Authorization flow",
    official_url: officialUrl({ ...auth, document_path: auth.redirect_document_path }),
    updated_at: new Date(Number(auth.update_time) * 1000).toISOString(),
    fetched_at: capture.fetched_at,
    verification: "Dokumen publik resmi; token nyata dan sandbox belum diverifikasi",
    contract_source: "Markdown resmi dalam panduan otorisasi",
  });
}
const docs = tree.map((node) => ({
  title: node.name,
  document_id: node.document_id,
  section: ancestry(node.document_id)[0],
  hierarchy: ancestry(node.document_id).join(" > "),
  directory: node.is_dir ? "Ya" : "Tidak",
  type: node.doc_type,
  api_document: node.is_api_doc ? "Ya" : "Tidak",
  official_url: officialUrl(node),
  updated_at: new Date(Number(node.update_time) * 1000).toISOString(),
  fetched_at: capture.fetched_at,
  headings: (details.get(node.document_id)?.content ?? "")
    .split("\n")
    .filter((line) => /^#{1,6}\s/.test(line))
    .join("; "),
  verification: node.is_dir ? "Direktori" : "Isi terambil; ketentuan tidak otomatis telah dipenuhi aplikasi",
}));
const review = details.get("6aaab59f8f408404f0b580c5");
if (!review) throw new Error("Missing app review requirements");
const reviewEvidence = {
  "ERP-001": "backend/src/modules/listing-copy; frontend/src/features/listing-copy",
  "ERP-002": "backend/src/modules/orders; frontend/src/features/orders",
  "ERP-003": "backend/src/modules/inventory; frontend/src/features/stock",
  "ERP-004": "backend/src/modules/fulfillment; frontend/src/features/shipping",
};
const reviewRows = review.content
  .split("\n")
  .filter((line) => /^\| [A-Z][A-Z0-9-]+-\d+ \|/.test(line))
  .map((line) => {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 5) throw new Error(`Unexpected review rule columns: ${cells[0]}`);
    return {
      rule_id: cells[0],
      category: cells[1],
      topic: cells[2],
      applies_to: cells[3],
      requirement: cells[4],
      application: reviewEvidence[cells[0]]
        ? "Alur ada; belum diverifikasi reviewer/sandbox"
        : "Belum diverifikasi; evaluasi sesuai market dan scope yang diajukan",
      evidence: reviewEvidence[cells[0]] ?? "",
      official_url: officialUrl({ ...review, document_path: review.redirect_document_path }),
      fetched_at: capture.fetched_at,
    };
  });
if (!reviewRows.length) throw new Error("No app review rules extracted");
const codeRows = [...references]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, evidence]) => ({
    request: key,
    evidence: [...evidence].join("; "),
    official_match: matched.has(key) ? "Ya" : "Perlu tinjauan",
  }));
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
for (const family of families) {
  const module = ancestry(family.document_id)[1];
  const counts = modules.get(module) ?? { total: 0, referenced: 0, defaultReferenced: 0 };
  const rows = apiRows.filter((row) => row.catalog_document_id === family.document_id);
  counts.total++;
  if (rows.some((row) => row.evidence)) counts.referenced++;
  if (rows.some((row) => row.catalog_default === "Ya" && row.evidence)) counts.defaultReferenced++;
  modules.set(module, counts);
}
const unmatched = codeRows.filter((row) => row.official_match !== "Ya");
const summary = `# Cakupan TikTok Shop — inventaris resmi\n\nSumber: https://partner.tiktokshop.com/docv2/page/about-partner-center-console. Snapshot publik workspace 3 diambil ${capture.fetched_at}. SHA-256 tree: \`${capture.tree_sha256}\`.\n\n${tree.length} entri navigasi: ${tree.filter((n) => n.is_dir).length} direktori dan ${tree.filter((n) => !n.is_dir).length} dokumen. API Reference memuat ${families.length} operasi dengan ${apiRows.length - 2} dokumen versi; 2 endpoint token berada di panduan otorisasi. ${references.size} kombinasi method/path kode ditemukan; ${matched.size} cocok dengan dokumentasi. Referensi kode tidak membuktikan kelengkapan fitur, market Indonesia, scope aktual atau keberhasilan sandbox.\n\n| Modul API Reference | Operasi katalog | Ada referensi pada salah satu versi | Referensi pada versi default katalog |\n|---|---:|---:|---:|\n${[...modules].map(([name, c]) => `| ${name} | ${c.total} | ${c.referenced} | ${c.defaultReferenced} |`).join("\n")}\n\nReferensi kode yang belum cocok:\n${unmatched.length ? unmatched.map((row) => `- \`${row.request}\`: ${row.evidence}`).join("\n") : "Tidak ada."}\n\nAST memproses kode produksi, termasuk template ID dan cabang literal activate/deactivate atau approve/reject; komentar, tes, metadata katalog/scope/outcome dan daftar target pengikatan aset diabaikan. Executor commerce umum dicatat terpisah dalam matriks operasi; deklarasi method/path bukan bukti alur khusus. Placeholder ID dinormalisasi hanya untuk pencocokan, dan metode HTTP tetap dibedakan. Versi lain pada dropdown tidak otomatis berarti kedaluwarsa. CSV dokumen mencakup Partner Guide, Developer Guide, API Reference, Webhooks, Terms and Policies, serta Changelog; isi terambil tidak membuktikan setiap ketentuan telah dipenuhi.\n`;
await mkdir(output, { recursive: true });
for (const [name, rows] of [
  ["ENDPOINTS", apiRows],
  ["DOKUMEN", docs],
  ["KODE", codeRows],
  ["REVIEW", reviewRows],
])
  await writeFile(path.join(output, `AUDIT-TIKTOKSHOP-${name}.csv`), csv(rows));
await writeFile(path.join(output, "AUDIT-TIKTOKSHOP-RINGKASAN.md"), summary);
console.log(
  JSON.stringify(
    {
      tree: tree.length,
      documents: docs.filter((d) => d.directory === "Tidak").length,
      families: families.length,
      versionEndpoints: apiRows.length,
      codeRequests: references.size,
      matched: matched.size,
      unmatched,
    },
    null,
    2,
  ),
);
