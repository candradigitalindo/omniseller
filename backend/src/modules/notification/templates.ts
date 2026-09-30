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
