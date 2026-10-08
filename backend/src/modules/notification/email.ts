import { logger } from "@omniseller/logging";
import nodemailer, { type Transporter } from "nodemailer";

/** A file sent with an email: drawn when the email goes out, never stored with the notification. */
export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
}

/** What a log line may say about attachments: their names and sizes, never their bytes. */
export function attachmentSummary(attachments: EmailAttachment[] | undefined): { filename: string; bytes: number }[] {
  return (attachments ?? []).map((a) => ({ filename: a.filename, bytes: a.content.length }));
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Injection token for the process-wide sender (worker only). */
export const EMAIL_SENDER = Symbol("EMAIL_SENDER");

/** Mailpit locally, the Amazon SES SMTP interface in staging and production. */
export class SmtpEmailSender implements EmailSender {
  constructor(
    smtpUrl: string,
    private readonly from: string,
    private readonly transport: Transporter = nodemailer.createTransport(smtpUrl),
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const { attachments, ...rest } = message;
    await this.transport.sendMail({
      from: this.from,
      ...rest,
      attachments: attachments?.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: Buffer.from(a.content),
      })),
    });
  }
}

/** Local development without an SMTP server: prints the message. Refused outside NODE_ENV=local. */
export class LogEmailSender implements EmailSender {
  private readonly log = logger.forModule("email");

  async send(message: EmailMessage): Promise<void> {
    // The redaction list covers `email`; `to` is the address of our own user, not a buyer.
    this.log.info(
      {
        to: message.to,
        subject: message.subject,
        body: message.text,
        attachments: attachmentSummary(message.attachments),
      },
      "email (log transport)",
    );
  }
}

/** Tests: keeps messages in memory. */
export class MemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  lastTo(to: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to.toLowerCase() === to.toLowerCase());
  }
}

export function createEmailSender(config: {
  EMAIL_TRANSPORT: "smtp" | "log" | "memory";
  SMTP_URL?: string | undefined;
  EMAIL_FROM: string;
}): EmailSender {
  switch (config.EMAIL_TRANSPORT) {
    case "smtp":
      return new SmtpEmailSender(config.SMTP_URL ?? "", config.EMAIL_FROM);
    case "log":
      return new LogEmailSender();
    case "memory":
      return new MemoryEmailSender();
  }
}
