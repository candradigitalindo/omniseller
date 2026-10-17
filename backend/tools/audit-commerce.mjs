import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { SHOPEE_COMMERCE_OPERATIONS } from "@omniseller/connector-shopee";
import { TIKTOK_COMMERCE_OPERATIONS } from "@omniseller/connector-tiktokshop";

// Run after pnpm build. Only reads the same static registry and policy used by the application.
// No marketplace requests, account credentials or third-party executable input are involved.
const require = createRequire(import.meta.url);
const { publicOperation } = require("../dist/modules/commerce/commerce-policy.js");
const root = path.resolve(import.meta.dirname, "../..");
const operations = [...SHOPEE_COMMERCE_OPERATIONS, ...TIKTOK_COMMERCE_OPERATIONS].map(publicOperation);
if (new Set(operations.map((operation) => operation.id)).size !== operations.length)
  throw new Error("Duplicate commerce operation id");
const rows = operations.map((operation) => ({
  platform: operation.channel,
  operation_id: operation.id,
  group: operation.group,
  principal: operation.principalKind,
  method: operation.method,
  path: operation.path,
  catalog: operation.id.startsWith("tiktok_large_") ? "Alur tambahan berkas besar" : "Katalog default",
  workspace_available: operation.available ? "Ya" : "Tidak",
  transport: operation.transport ?? "json",
  action: operation.write ? "Perubahan" : "Pembacaan",
  required_permissions: operation.requiredPermissions.join("; "),
  scopes_or_app_programs: (operation.appPrograms ?? operation.scopes).join("; "),
  scope_rule:
    operation.authMode === "shopee_app_program" ? "Persetujuan app/program Shopee" : (operation.scopeMode ?? "all"),
  account_requirements: (operation.accountRequirements ?? []).join("; "),
  unavailable_reason: operation.unavailableReason ?? "",
  ui: operation.available ? "/commerce" : "Lihat alasan dan alur khusus pada katalog",
  official_url: operation.officialUrl,
  verification: "Kontrak dan pengujian lokal; akses program dan sandbox nyata belum diverifikasi",
}));
const cell = (value) => {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};
const fields = Object.keys(rows[0]);
const csv = `\uFEFF${[fields, ...rows.map((row) => fields.map((field) => row[field]))].map((row) => row.map(cell).join(",")).join("\n")}\n`;
const platforms = Object.fromEntries(
  ["shopee", "tiktokshop"].map((platform) => {
    const all = operations.filter((operation) => operation.channel === platform);
    return [
      platform,
      {
        operations: all.length,
        workspaceAvailable: all.filter((operation) => operation.available).length,
        unavailableOrDedicated: all.filter((operation) => !operation.available).length,
        groups: [...new Set(all.map((operation) => operation.group))].sort(),
        byPrincipal: Object.fromEntries(
          ["seller", "creator", "affiliate_partner"].map((principal) => {
            const subset = all.filter((operation) => operation.principalKind === principal);
            return [
              principal,
              { total: subset.length, available: subset.filter((operation) => operation.available).length },
            ];
          }),
        ),
      },
    ];
  }),
);
await mkdir(path.join(root, "backend/docs/audits"), { recursive: true });
await writeFile(path.join(root, "IMPLEMENTASI-COMMERCE-OPERASI.csv"), csv);
await writeFile(
  path.join(root, "backend/docs/audits/commerce-coverage.json"),
  `${JSON.stringify(
    {
      meaning:
        "Executable workspace contracts, not proof of live marketplace approval. Unavailable includes dedicated existing workflows and unsupported contracts/principals/regions.",
      platforms,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify(platforms, null, 2));
