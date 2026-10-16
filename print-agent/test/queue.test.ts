import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PrintQueue } from "../src/core/queue";
import type { RemoteJob } from "../src/core/types";
export const job: RemoteJob = {
  id: "01K6MQB3P30000000000000001",
  attempt: 1,
  kind: "label",
  title: "Buyer private text",
  printer: "Thermal",
  copies: 1,
  createdAt: "2026-10-16T00:00:00.000Z",
};
test("journal survives restart without reprinting an ambiguous OS call; attempts and devices stay separate", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-queue-"));
  const path = join(dir, "queue.db");
  let q = new PrintQueue(path, "device-a");
  try {
    q.enqueue(job);
    q.enqueue(job);
    assert.equal(q.all().length, 1);
    q.change(job, "printing");
    q.close();
    q = new PrintQueue(path, "device-a");
    assert.equal(q.all()[0]!.state, "uncertain");
    q.change(job, "printed");
    q.reported(job);
    q.enqueue(job);
    assert.equal(q.all()[0]!.state, "printed");
    q.enqueue({ ...job, attempt: 2 });
    q.enqueue(job);
    assert.deepEqual(
      q.all().map((j) => [j.attempt, j.state]),
      [
        [1, "printed"],
        [2, "queued"],
      ],
    );
    q.close();
    q = new PrintQueue(path, "device-b");
    assert.deepEqual(q.all(), []);
    q.enqueue(job);
    q.cancel(job.id);
    assert.equal(q.all()[0]!.state, "cancelled");
    q.close();
    q = new PrintQueue(path, "device-a");
    assert.equal(q.all().length, 2);
    assert.equal(readFileSync(path).includes(Buffer.from(job.title)), false);
  } finally {
    q.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("newer explicit attempts retire old queued work; retries back off and unacknowledged work is retained", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-queue-"));
  const q = new PrintQueue(join(dir, "q.db"), "a");
  try {
    q.enqueue(job);
    q.enqueue({ ...job, attempt: 2 });
    assert.equal(q.all()[0]!.state, "cancelled");
    const row = q.all()[1]!;
    q.retry(row, "printer_busy", 1000);
    assert.equal(q.all()[1]!.dueAt, 3000);
    q.prune(Date.now() + 30 * 86400_000);
    assert.equal(q.all().length, 1);
    assert.equal(q.all()[0]!.attempt, 2);
  } finally {
    q.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
