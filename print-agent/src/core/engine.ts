import { rm } from "node:fs/promises";
import type { PrintQueue } from "./queue";
import {
  type AgentApi,
  AgentError,
  type AgentSelf,
  type ErrorCode,
  type LocalJob,
  type Preferences,
  type Printer,
  type PrinterDriver,
} from "./types";

export class PrintEngine {
  paused = false;
  connected = false;
  error: ErrorCode | null = null;
  printers: Printer[] = [];
  self: AgentSelf | null = null;
  private stopped = false;
  private work: Promise<void> | undefined;
  private syncing: Promise<void> | undefined;
  private readonly abort = new AbortController();
  constructor(
    readonly queue: PrintQueue,
    private readonly api: AgentApi,
    private readonly driver: PrinterDriver,
    private readonly changed: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}
  async sync(preferences?: Preferences): Promise<void> {
    if (this.stopped) return;
    if (this.syncing) {
      await this.syncing;
      if (preferences) return this.sync(preferences);
      return;
    }
    this.syncing = (async () => {
      try {
        this.printers = (await this.driver.list()).slice(0, 50);
        this.self = await this.api.status(this.printers, preferences);
        const jobs = await this.api.pending();
        for (const job of jobs) this.queue.enqueue(job);
        this.connected = true;
        this.error = null;
        this.queue.prune();
      } catch (error) {
        this.connected = false;
        this.error = error instanceof AgentError ? error.code : "connection";
      }
      this.changed();
    })();
    try {
      await this.syncing;
    } finally {
      this.syncing = undefined;
    }
    await this.tick();
  }
  async tick(): Promise<void> {
    if (this.stopped || !this.connected || this.work) return this.work;
    this.work = this.drain().catch((error: unknown) => {
      this.error = error instanceof AgentError ? error.code : "storage";
      this.changed();
    });
    try {
      await this.work;
    } finally {
      this.work = undefined;
    }
  }
  private async acknowledge(job: LocalJob): Promise<void> {
    try {
      await this.api.result(
        job,
        job.state === "printed" ? "printed" : "failed",
        job.error ? `agent.${job.error}` : undefined,
      );
      this.queue.reported(job);
    } catch (error) {
      if (error instanceof AgentError && [404, 409].includes(error.status)) this.queue.reported(job);
      else {
        this.queue.retry(job, error instanceof AgentError ? error.code : "connection", this.now());
        this.onFailure(error);
      }
    }
  }
  private onFailure(error: unknown): void {
    this.error = error instanceof AgentError ? error.code : "connection";
    if (this.error === "auth" || this.error === "connection") this.connected = false;
  }
  private async drain(): Promise<void> {
    let processed = 0;
    for (const job of this.queue.all()) {
      if (this.stopped || !this.connected) break;
      if (job.reported || job.dueAt > this.now()) continue;
      if (job.state === "printed" || job.state === "failed") {
        await this.acknowledge(job);
        continue;
      }
      if (job.state !== "queued" || this.paused) continue;
      let file: string | undefined;
      try {
        file = await this.api.download(job, this.abort.signal);
        if (
          this.stopped ||
          this.paused ||
          this.queue.all().find((j) => j.id === job.id && j.attempt === job.attempt)?.state !== "queued"
        )
          continue;
        const printers = await this.driver.list();
        // Printer enumeration is asynchronous: cancellation or pause may arrive while it runs.
        if (
          this.stopped ||
          this.paused ||
          this.queue.all().find((j) => j.id === job.id && j.attempt === job.attempt)?.state !== "queued"
        )
          continue;
        const printer = job.printer ? printers.find((p) => p.name === job.printer) : printers.find((p) => p.isDefault);
        if (!printer) throw new AgentError("printer_missing");
        if (printer.ready === false) throw new AgentError("printer_busy");
        // Persist before the OS call. A restart in this state requires a person to inspect the printer.
        this.queue.change(job, "printing");
        this.changed();
        try {
          await this.driver.print(file, printer.name, job.copies);
          this.queue.change(job, "printed");
        } catch {
          this.queue.change(job, "uncertain", "interrupted");
        }
        processed++;
      } catch (error) {
        if (this.stopped) break;
        if (error instanceof AgentError && [404, 409].includes(error.status)) {
          this.queue.change(job, "cancelled");
          this.queue.reported(job);
        } else {
          const code = error instanceof AgentError ? error.code : "storage";
          if (
            ["pdf_invalid", "pdf_too_large"].includes(code) ||
            (job.retries >= 4 && ["printer_missing", "printer_busy"].includes(code))
          )
            this.queue.change(job, "failed", code);
          else this.queue.retry(job, code, this.now());
          this.onFailure(error);
        }
      } finally {
        if (file)
          await rm(file, { force: true }).catch(() => {
            this.error = "storage";
          });
      }
      const settled = this.queue.all().find((j) => j.id === job.id && j.attempt === job.attempt);
      if (settled && ["printed", "failed"].includes(settled.state)) await this.acknowledge(settled);
      this.changed();
    }
    // Follow the next page after a burst. Uncertain jobs do not cause a busy polling loop.
    if (processed > 0 && !this.paused && !this.stopped && this.connected) {
      const jobs = await this.api.pending().catch(() => []);
      for (const job of jobs) this.queue.enqueue(job);
    }
  }
  cancel(id: string): void {
    this.queue.cancel(id);
    this.changed();
  }
  async retry(id: string): Promise<void> {
    await this.api.retry(id);
    await this.sync();
  }
  async testPrint(): Promise<void> {
    await this.api.testPrint();
    await this.sync();
  }
  resolve(id: string, attempt: number, result: "printed" | "failed"): void {
    const row = this.queue.all().find((j) => j.id === id && j.attempt === attempt);
    if (row?.state !== "uncertain") throw new AgentError("request_rejected");
    this.queue.change(row, result, result === "failed" ? "interrupted" : null);
    this.changed();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.syncing;
    await this.work;
  }
}
