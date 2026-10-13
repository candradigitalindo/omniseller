import { Writable } from "node:stream";
import { configureLogger } from "@omniseller/logging";
import nodemailer from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import { attachmentSummary, type EmailMessage, LogEmailSender, SmtpEmailSender } from "./email";
import { EmailAttachments } from "./email-attachments";

const pdf = new Uint8Array(Buffer.from("%PDF-1.7\n%%EOF\n"));
const message: EmailMessage = {
  to: "rina@contoh.id",
  subject: "Pembayaran INV-2610-0001 diterima (Toko Maju)",
  text: "Halo Rina,",
  html: "<p>Halo Rina,</p>",
  attachments: [{ filename: "INV-2610-0001.pdf", contentType: "application/pdf", content: pdf }],
};

/** SMTP as nodemailer would write it, kept instead of sent. */
function capture() {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const raw: string[] = [];
  const send = transport.sendMail.bind(transport);
  vi.spyOn(transport, "sendMail").mockImplementation(async (mail) => {
    const info = await send(mail);
    raw.push((info.message as Buffer).toString("utf8"));
    return info;
  });
  return { sender: new SmtpEmailSender("smtp://unused", "OmniSeller <noreply@omniseller.id>", transport), raw };
}

describe("email (backend doc 8.17)", () => {
  it("sends attachments as files of the message", async () => {
    const { sender, raw } = capture();
    await sender.send(message);
    expect(raw[0]).toMatch(/Content-Type: application\/pdf; name=INV-2610-0001\.pdf/);
    expect(raw[0]).toMatch(/Content-Disposition: attachment; filename=INV-2610-0001\.pdf/);
    expect(raw[0]).toContain(Buffer.from(pdf).toString("base64").slice(0, 16));
    // a message without files is a plain one
    await sender.send({ ...message, attachments: undefined });
    expect(raw[1]).not.toContain("Content-Disposition: attachment");
  });

  it("logs the names and sizes of attachments, never their bytes", async () => {
    expect(attachmentSummary(message.attachments)).toEqual([{ filename: "INV-2610-0001.pdf", bytes: pdf.length }]);
    expect(attachmentSummary(undefined)).toEqual([]);
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    configureLogger({ level: "info", destination });
    await new LogEmailSender().send(message);
    const logged = lines.join("");
    expect(JSON.parse(lines[0]!).attachments).toEqual([{ filename: "INV-2610-0001.pdf", bytes: pdf.length }]);
    expect(logged).not.toContain(Buffer.from(pdf).toString("base64"));
    expect(logged).not.toContain("%PDF");
  });

  it("asks every registered source for an email's files, in order", async () => {
    const files = new EmailAttachments();
    const ctx = {} as never;
    expect(await files.for(ctx, { kind: "billing.reminder", userId: null, data: {} })).toEqual([]);
    files.register(async (_ctx, n) => (n.kind === "a" ? [message.attachments![0]!] : []));
    files.register(async () => [{ filename: "b.txt", contentType: "text/plain", content: new Uint8Array([98]) }]);
    expect((await files.for(ctx, { kind: "a", userId: null, data: {} })).map((f) => f.filename)).toEqual([
      "INV-2610-0001.pdf",
      "b.txt",
    ]);
    expect((await files.for(ctx, { kind: "z", userId: null, data: {} })).map((f) => f.filename)).toEqual(["b.txt"]);
    // a source that fails fails the email (the job retries it)
    files.register(async () => {
      throw new Error("down");
    });
    await expect(files.for(ctx, { kind: "a", userId: null, data: {} })).rejects.toThrow("down");
  });
});
