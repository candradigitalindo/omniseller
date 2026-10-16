import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ErrorCode, LocalJob, LocalState, RemoteJob } from "./types";

/** One durable journal, partitioned by API origin and device id; no token, title, URL, or PDF is stored. */
export class PrintQueue {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly binding: string,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 1) {
      this.db.close();
      throw new Error("unsupported queue version");
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS job (
      binding TEXT NOT NULL, id TEXT NOT NULL, attempt INTEGER NOT NULL, kind TEXT NOT NULL,
      printer TEXT, copies INTEGER NOT NULL, createdAt TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued', reported INTEGER NOT NULL DEFAULT 0,
      retries INTEGER NOT NULL DEFAULT 0, dueAt INTEGER NOT NULL DEFAULT 0, error TEXT,
      updatedAt INTEGER NOT NULL, PRIMARY KEY (binding, id, attempt)); PRAGMA user_version=1;`);
    this.db
      .prepare("UPDATE job SET state='uncertain', error='interrupted' WHERE binding=? AND state='printing'")
      .run(binding);
  }
  enqueue(job: RemoteJob): void {
    this.db
      .prepare("UPDATE job SET state='cancelled', reported=1 WHERE binding=? AND id=? AND attempt<? AND state='queued'")
      .run(this.binding, job.id, job.attempt);
    const latest = this.db
      .prepare("SELECT max(attempt) AS attempt FROM job WHERE binding=? AND id=?")
      .get(this.binding, job.id) as { attempt: number | null };
    if (latest.attempt !== null && latest.attempt > job.attempt) return;
    this.db
      .prepare(
        `INSERT INTO job (binding,id,attempt,kind,printer,copies,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      )
      .run(this.binding, job.id, job.attempt, job.kind, job.printer, job.copies, job.createdAt, Date.now());
  }
  all(): LocalJob[] {
    return this.db
      .prepare(
        "SELECT id,attempt,kind,printer,copies,createdAt,state,reported,retries,dueAt,error FROM job WHERE binding=? ORDER BY createdAt,id,attempt",
      )
      .all(this.binding) as unknown as LocalJob[];
  }
  change(job: Pick<LocalJob, "id" | "attempt">, state: LocalState, error: ErrorCode | null = null): void {
    this.db
      .prepare("UPDATE job SET state=?,error=?,updatedAt=? WHERE binding=? AND id=? AND attempt=?")
      .run(state, error, Date.now(), this.binding, job.id, job.attempt);
  }
  retry(job: LocalJob, error: ErrorCode, now: number): void {
    this.db
      .prepare("UPDATE job SET retries=retries+1,dueAt=?,error=?,updatedAt=? WHERE binding=? AND id=? AND attempt=?")
      .run(now + Math.min(60_000, 2000 * 2 ** job.retries), error, now, this.binding, job.id, job.attempt);
  }
  reported(job: Pick<LocalJob, "id" | "attempt">): void {
    this.db
      .prepare("UPDATE job SET reported=1,updatedAt=? WHERE binding=? AND id=? AND attempt=?")
      .run(Date.now(), this.binding, job.id, job.attempt);
  }
  cancel(id: string): void {
    this.db
      .prepare("UPDATE job SET state='cancelled',reported=1,updatedAt=? WHERE binding=? AND id=? AND state='queued'")
      .run(Date.now(), this.binding, id);
  }
  prune(now = Date.now()): void {
    this.db
      .prepare("DELETE FROM job WHERE binding=? AND reported=1 AND updatedAt<?")
      .run(this.binding, now - 7 * 86400_000);
  }
  close(): void {
    this.db.close();
  }
}
