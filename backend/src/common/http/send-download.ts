import type { Response } from "express";
import type { DownloadTarget } from "../../modules/files/files.service";

/** A file made for this request (a CSV or a workbook) as a download, never cached. */
export function sendAttachment(res: Response, fileName: string, mime: string, body: string | Uint8Array): void {
  res.setHeader("content-type", mime);
  res.setHeader("content-disposition", `attachment; filename="${fileName}"`);
  res.setHeader("cache-control", "private, no-store");
  res.send(typeof body === "string" ? body : Buffer.from(body));
}

/**
 * A private file in the response: a redirect to a signed link valid for 10 minutes (R2), or the bytes
 * themselves (local storage). Never cached.
 */
export function sendDownload(res: Response, target: DownloadTarget): void {
  res.setHeader("cache-control", "private, no-store");
  if ("url" in target) {
    res.redirect(302, target.url);
    return;
  }
  res.setHeader("content-type", target.mime);
  res.setHeader("content-disposition", `${target.disposition}; filename="${encodeURIComponent(target.filename)}"`);
  res.send(Buffer.from(target.bytes));
}
