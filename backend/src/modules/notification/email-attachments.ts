import { Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { EmailAttachment } from "./email";

/** The notification an email is about, as an attachment source sees it. */
export interface AttachingNotification {
  kind: string;
  data: Record<string, unknown>;
}

/** The files to send with one notification's email; [] when the source has none for it. */
export type AttachmentSource = (ctx: RequestContext, n: AttachingNotification) => Promise<EmailAttachment[]>;

/**
 * Files sent with notification emails (job `notification.email`, backend doc 8.17). A module that imports
 * notifications registers a source when its worker module starts (billing: the paid invoice as PDF), so
 * notifications never import it. Every email asks every source; a source that throws fails the job, and
 * BullMQ retries it before anything is sent.
 */
@Injectable()
export class EmailAttachments {
  private readonly sources: AttachmentSource[] = [];

  register(source: AttachmentSource): void {
    this.sources.push(source);
  }

  async for(ctx: RequestContext, n: AttachingNotification): Promise<EmailAttachment[]> {
    const files: EmailAttachment[] = [];
    for (const source of this.sources) files.push(...(await source(ctx, n)));
    return files;
  }
}
