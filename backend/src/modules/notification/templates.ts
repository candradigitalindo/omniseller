import type { EmailMessage } from "./email";

/**
 * Plain templates for account emails (tone: DOKUMEN-UI-UX 12). Rendered with React Email when the
 * notification module grows; kept dependency-free until then.
 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(title: string, paragraphs: string[], action: { label: string; url: string }, footer: string): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join("");
  return `<!doctype html><html lang="id"><body style="font-family:Inter,Arial,sans-serif;background:#F4F6F8;color:#1B2430;padding:24px">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E1E5EA;border-radius:10px;padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>${body}
<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#1E6B8C;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p>
<p style="font-size:13px;color:#3D4754;margin:0">${escapeHtml(footer)}</p></div></body></html>`;
}

export function invitationEmail(input: {
  to: string;
  tenantName: string;
  roleName: string;
  inviterName: string | null;
  url: string;
  expiresHours: number;
}): EmailMessage {
  const who = input.inviterName ? `${input.inviterName} mengundang Anda` : "Anda diundang";
  const lines = [
    `${who} bergabung dengan ${input.tenantName} di OmniSeller sebagai ${input.roleName}.`,
    `Tautan ini berlaku ${input.expiresHours} jam.`,
  ];
  const footer = "Bila Anda tidak mengenal pengirim undangan ini, abaikan email ini.";
  return {
    to: input.to,
    subject: `Undangan bergabung dengan ${input.tenantName} di OmniSeller`,
    text: `${lines.join("\n")}\n\nTerima undangan: ${input.url}\n\n${footer}`,
    html: layout("Undangan bergabung", lines, { label: "Terima undangan", url: input.url }, footer),
  };
}

/** An in-app notification that also goes out by email (store connection lost, backend doc 8.23). */
export function notificationEmail(input: {
  to: string;
  name: string;
  tenantName: string;
  title: string;
  body: string;
  url: string;
}): EmailMessage {
  const lines = [`Halo ${input.name},`, input.body];
  const footer = `Email ini dikirim ke pengguna ${input.tenantName} yang mengelola toko di OmniSeller.`;
  return {
    to: input.to,
    subject: `${input.title} (${input.tenantName})`,
    text: `${lines.join("\n\n")}\n\nBuka OmniSeller: ${input.url}\n\n${footer}`,
    html: layout(input.title, lines, { label: "Buka OmniSeller", url: input.url }, footer),
  };
}

export function passwordResetEmail(input: {
  to: string;
  tenantName: string;
  url: string;
  expiresMinutes: number;
}): EmailMessage {
  const lines = [
    `Ada permintaan untuk mengatur ulang kata sandi akun OmniSeller Anda di ${input.tenantName}.`,
    `Tautan ini berlaku ${input.expiresMinutes} menit dan hanya bisa dipakai sekali.`,
  ];
  const footer = "Bila Anda tidak meminta ini, abaikan email ini. Kata sandi Anda tidak berubah.";
  return {
    to: input.to,
    subject: "Atur ulang kata sandi OmniSeller",
    text: `${lines.join("\n")}\n\nAtur ulang kata sandi: ${input.url}\n\n${footer}`,
    html: layout("Atur ulang kata sandi", lines, { label: "Atur ulang kata sandi", url: input.url }, footer),
  };
}

/** What the daily operational email reports (PRD FR-NTF-02); sections the reader may not see are null. */
export interface DigestSummary {
  /** The local day reported (yesterday when sent), YYYY-MM-DD. */
  date: string;
  sales: {
    orders: number;
    revenue: number;
    previousOrders: number;
    previousRevenue: number;
    top: { name: string; units: number }[];
  } | null;
  orders: { new: number; toShip: number; overdue: number; dueSoon: number; problem: number } | null;
  stock: { critical: number; items: { sku: string; name: string; available: number; warehouse: string }[] } | null;
  /** Stores that need a look: reconnect, authorization ending, sync behind. */
  stores: { name: string; reason: string }[] | null;
}

const rupiah = (n: number) => `Rp${n.toLocaleString("id-ID")}`;
const count = (n: number) => n.toLocaleString("id-ID");

/** "Sabtu, 3 Oktober 2026". */
export function longDate(date: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function change(now: number, before: number): string {
  if (before === 0) return now > 0 ? "baru ada penjualan" : "sama dengan hari sebelumnya";
  const pct = Math.round(((now - before) / before) * 1000) / 10;
  if (pct === 0) return "sama dengan hari sebelumnya";
  return `${pct > 0 ? "naik" : "turun"} ${Math.abs(pct).toLocaleString("id-ID")}% dari hari sebelumnya`;
}

/** The daily operational summary (FR-NTF-02, tone DOKUMEN-UI-UX 12). */
export function dailyDigestEmail(input: {
  to: string;
  name: string;
  tenantName: string;
  summary: DigestSummary;
  url: string;
}): EmailMessage {
  const s = input.summary;
  const sections: { title: string; lines: string[] }[] = [];
  if (s.sales) {
    sections.push({
      title: "Penjualan",
      lines: [
        `${count(s.sales.orders)} pesanan, ${rupiah(s.sales.revenue)}, ${change(s.sales.revenue, s.sales.previousRevenue)}.`,
        ...(s.sales.top.length > 0
          ? [`Terlaris: ${s.sales.top.map((t) => `${t.name} (${count(t.units)})`).join(", ")}.`]
          : []),
      ],
    });
  }
  if (s.orders) {
    sections.push({
      title: "Pesanan",
      lines: [
        `${count(s.orders.toShip)} pesanan harus dikirim${s.orders.overdue > 0 ? `, ${count(s.orders.overdue)} sudah lewat batas kirim` : ""}${s.orders.dueSoon > s.orders.overdue ? `, ${count(s.orders.dueSoon - s.orders.overdue)} jatuh tempo dalam 6 jam` : ""}.`,
        `${count(s.orders.new)} pesanan baru menunggu diproses${s.orders.problem > 0 ? `, ${count(s.orders.problem)} bermasalah` : ""}.`,
      ],
    });
  }
  if (s.stock) {
    sections.push({
      title: "Stok",
      lines:
        s.stock.critical === 0
          ? ["Tidak ada stok yang habis atau menipis."]
          : [
              `${count(s.stock.critical)} produk habis atau menipis.`,
              ...s.stock.items.map((i) => `${i.sku} ${i.name}: sisa ${count(i.available)} di ${i.warehouse}`),
            ],
    });
  }
  if (s.stores && s.stores.length > 0) {
    sections.push({ title: "Toko", lines: s.stores.map((t) => `${t.name}: ${t.reason}`) });
  }
  const day = longDate(s.date);
  const subject = `Ringkasan ${input.tenantName}, ${day}`;
  const intro = `Halo ${input.name}, ini ringkasan ${input.tenantName} untuk ${day}.`;
  const footer = "Email ini dikirim setiap pagi. Matikan di Pengaturan, Notifikasi bila tidak diperlukan.";
  const text = [
    intro,
    ...sections.flatMap((x) => ["", x.title.toUpperCase(), ...x.lines.map((l) => `- ${l}`)]),
    "",
    `Buka dasbor: ${input.url}`,
    "",
    footer,
  ].join("\n");
  const htmlSections = sections
    .map(
      (x) =>
        `<h2 style="font-size:16px;margin:20px 0 8px">${escapeHtml(x.title)}</h2><ul style="margin:0;padding-left:20px">${x.lines
          .map((l) => `<li style="margin:0 0 6px">${escapeHtml(l)}</li>`)
          .join("")}</ul>`,
    )
    .join("");
  const html = `<!doctype html><html lang="id"><body style="font-family:Inter,Arial,sans-serif;background:#F4F6F8;color:#1B2430;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E1E5EA;border-radius:10px;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(`Ringkasan ${day}`)}</h1>
<p style="margin:0 0 8px">${escapeHtml(intro)}</p>${htmlSections}
<p style="margin:24px 0"><a href="${escapeHtml(input.url)}" style="background:#1E6B8C;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Buka dasbor</a></p>
<p style="font-size:13px;color:#3D4754;margin:0">${escapeHtml(footer)}</p></div></body></html>`;
  return { to: input.to, subject, text, html };
}
