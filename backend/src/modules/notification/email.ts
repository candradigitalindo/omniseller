import { logger } from "@omniseller/logging";
import nodemailer, { type Transporter } from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Injection token for the process-wide sender (worker only). */
export const EMAIL_SENDER = Symbol("EMAIL_SENDER");

/** Mailpit locally, the Amazon SES SMTP interface in staging and production. */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

/** Local development without an SMTP server: prints the message. Refused outside NODE_ENV=local. */
export class LogEmailSender implements EmailSender {
  private readonly log = logger.forModule("email");

  async send(message: EmailMessage): Promise<void> {
    // The redaction list covers `email`; `to` is the address of our own user, not a buyer.
    this.log.info({ to: message.to, subject: message.subject, body: message.text }, "email (log transport)");
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
