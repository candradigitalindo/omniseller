import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type AgentApi, AgentError, type AgentSelf, type Preferences, type Printer, type RemoteJob } from "./types";

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const jobSchema = z.object({
  id: ulid,
  attempt: z.number().int().positive(),
  kind: z.enum(["label", "pick_list", "packing_list", "invoice", "barcode", "manifest", "test"]),
  printer: z.string().max(200).nullable(),
  copies: z.number().int().min(1).max(10),
  createdAt: z.iso.datetime(),
});
const selfSchema = z.object({
  id: ulid,
  name: z.string().max(200),
  labelPrinter: z.string().nullable(),
  documentPrinter: z.string().nullable(),
});
const MAX_PDF = 50 * 1024 * 1024;

export function validateOrigin(value: string, development = false): string {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    if (
      url.protocol !== "https:" &&
      !(development && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new AgentError("request_rejected");
  }
}

/** Manual redirect handling keeps the device token off signed storage requests. */
export class HttpAgentApi implements AgentApi {
  constructor(
    readonly origin: string,
    private readonly token: string,
    private readonly version: string,
    private readonly pdfDirectory: string,
    private readonly development = false,
    private readonly request: typeof fetch = fetch,
  ) {}
  private async json(path: string, method = "GET", body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(`${this.origin}/v1/agent/${path}`, {
        method,
        redirect: "error",
        credentials: "omit",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AgentError("connection");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AgentError([401, 403].includes(response.status) ? "auth" : "request_rejected", response.status);
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 1024 * 1024) {
      await response.body?.cancel();
      throw new AgentError("request_rejected");
    }
    let text = "";
    let total = 0;
    const decoder = new TextDecoder();
    const reader = response.body?.getReader();
    if (reader)
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.length;
        text += decoder.decode(chunk.value, { stream: true });
        if (total > 1024 * 1024) {
          await reader.cancel();
          throw new AgentError("request_rejected");
        }
      }
    text += decoder.decode();
    try {
      return JSON.parse(text);
    } catch {
      throw new AgentError("request_rejected");
    }
  }
  async status(printers: Printer[], preferences?: Preferences): Promise<AgentSelf> {
    const parsed = selfSchema.safeParse(
      await this.json("status", "PUT", {
        appVersion: this.version,
        printers: printers.map(({ name, isDefault }) => ({ name, isDefault })),
        ...preferences,
      }),
    );
    if (!parsed.success) throw new AgentError("request_rejected");
    return parsed.data;
  }
  async pending(): Promise<RemoteJob[]> {
    const parsed = z.object({ items: z.array(jobSchema).max(50) }).safeParse(await this.json("print-jobs"));
    if (!parsed.success) throw new AgentError("request_rejected");
    // A title is not needed for printing and never enters the local journal.
    return parsed.data.items.map((job) => ({ ...job, title: "" }));
  }
  async retry(id: string): Promise<void> {
    await this.json(`print-jobs/${id}/retry`, "POST", {});
  }
  async testPrint(): Promise<void> {
    await this.json("test-print", "POST", {});
  }
  async result(job: Pick<RemoteJob, "id" | "attempt">, status: "printed" | "failed", error?: string): Promise<void> {
    await this.json(`print-jobs/${job.id}/result`, "POST", {
      status,
      attempt: job.attempt,
      ...(error ? { error } : {}),
    });
  }
  async download(job: Pick<RemoteJob, "id" | "attempt">, signal?: AbortSignal): Promise<string> {
    let url = `${this.origin}/v1/agent/print-jobs/${job.id}/file?attempt=${job.attempt}`;
    let response: Response | undefined;
    const abort = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const target = new URL(url);
        validateOrigin(target.origin, this.development);
        if (target.username || target.password) throw new AgentError("pdf_invalid");
        response = await this.request(url, {
          redirect: "manual",
          credentials: "omit",
          signal: abort,
          headers: redirects === 0 ? { authorization: `Bearer ${this.token}` } : {},
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 3) throw new AgentError("pdf_invalid");
        url = new URL(location, url).toString();
      }
      if (!response?.ok) {
        await response?.body?.cancel();
        throw new AgentError(
          [401, 403].includes(response?.status ?? 0) ? "auth" : "request_rejected",
          response?.status,
        );
      }
      if (Number(response.headers.get("content-length") ?? 0) > MAX_PDF) {
        await response.body?.cancel();
        throw new AgentError("pdf_too_large");
      }
      await mkdir(this.pdfDirectory, { recursive: true, mode: 0o700 });
      const path = join(this.pdfDirectory, `${randomUUID()}.pdf`);
      const file = await open(path, "wx", 0o600);
      try {
        let total = 0;
        let header = Buffer.alloc(0);
        if (!response.body) throw new AgentError("pdf_invalid");
        for await (const chunk of response.body) {
          total += chunk.length;
          if (total > MAX_PDF) throw new AgentError("pdf_too_large");
          if (header.length < 5) header = Buffer.concat([header, chunk]).subarray(0, 5);
          await file.writeFile(chunk);
        }
        if (header.toString("ascii") !== "%PDF-") throw new AgentError("pdf_invalid");
        await file.close();
        return path;
      } catch (error) {
        await file.close();
        await rm(path, { force: true });
        throw error;
      }
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError("connection");
    }
  }
}
