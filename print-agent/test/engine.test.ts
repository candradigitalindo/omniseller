import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PrintEngine } from "../src/core/engine";
import { PrintQueue } from "../src/core/queue";
import { type AgentApi, AgentError, type Printer } from "../src/core/types";

const job = {
  id: "01K6MQB3P30000000000000001",
  attempt: 1,
  kind: "label" as const,
  title: "",
  printer: "Thermal",
  copies: 2,
  createdAt: "2026-10-16T00:00:00.000Z",
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "omni-engine-"));
  const pdf = join(dir, "pdf");
  const queue = new PrintQueue(join(dir, "q.db"), "a");
  let now = 0,
    prints = 0,
    downloads = 0,
    reports = 0,
    ackFail = false,
    printFail = false,
    revoked = false;
  let printers: Printer[] = [{ name: "Thermal", isDefault: true }];
  let pending = [job];
  const api: AgentApi = {
    status: async () => ({ id: job.id, name: "PC Gudang", labelPrinter: null, documentPrinter: null }),
    pending: async () => pending,
    download: async () => {
      downloads++;
      if (revoked) throw new AgentError("auth", 401);
      await writeFile(pdf, "%PDF-1.7");
      return pdf;
    },
    result: async () => {
      reports++;
      if (ackFail) throw new AgentError("connection");
      pending = [];
    },
    testPrint: async () => {},
    retry: async () => {
      pending = [{ ...job, attempt: 2 }];
    },
  };
  const engine = new PrintEngine(
    queue,
    api,
    {
      list: async () => printers,
      print: async () => {
        prints++;
        if (printFail) throw new Error("driver uncertain");
      },
    },
    () => {},
    () => now,
  );
  return {
    engine,
    queue,
    dir,
    get prints() {
      return prints;
    },
    get downloads() {
      return downloads;
    },
    get reports() {
      return reports;
    },
    set ackFail(v: boolean) {
      ackFail = v;
    },
    set printFail(v: boolean) {
      printFail = v;
    },
    set revoked(v: boolean) {
      revoked = v;
    },
    set printers(v: Printer[]) {
      printers = v;
    },
    advance() {
      now += 120_000;
    },
    async close() {
      await engine.stop();
      queue.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("lost result acknowledgement retries the report, never the print, including after catch-up", async () => {
  const f = await fixture();
  try {
    f.ackFail = true;
    await f.engine.sync();
    assert.equal(f.prints, 1);
    assert.equal(f.queue.all()[0]!.state, "printed");
    assert.equal(f.queue.all()[0]!.reported, 0);
    assert.equal((await readdir(f.dir)).includes("pdf"), false);
    f.ackFail = false;
    f.advance();
    await f.engine.sync();
    await f.engine.sync();
    assert.equal(f.prints, 1);
    assert.equal(f.reports, 2);
    assert.equal(f.queue.all()[0]!.reported, 1);
  } finally {
    await f.close();
  }
});
test("driver uncertainty requires an explicit decision and cleans the private PDF", async () => {
  const f = await fixture();
  try {
    f.printFail = true;
    await f.engine.sync();
    assert.equal(f.queue.all()[0]!.state, "uncertain");
    await f.engine.sync();
    assert.equal(f.prints, 1);
    assert.equal(f.reports, 0);
    f.engine.resolve(job.id, 1, "printed");
    await f.engine.tick();
    assert.equal(f.reports, 1);
    assert.equal(f.prints, 1);
    assert.equal((await readdir(f.dir)).includes("pdf"), false);
  } finally {
    await f.close();
  }
});
test("pause and cancellation block printing; a missing printer fails after bounded retries", async () => {
  const f = await fixture();
  try {
    f.engine.paused = true;
    await f.engine.sync();
    assert.equal(f.downloads, 0);
    f.engine.cancel(job.id);
    f.engine.paused = false;
    await f.engine.tick();
    assert.equal(f.prints, 0);
  } finally {
    await f.close();
  }
  const g = await fixture();
  try {
    g.printers = [];
    for (let i = 0; i < 5; i++) {
      g.advance();
      await g.engine.sync();
    }
    assert.equal(g.prints, 0);
    assert.equal(g.queue.all()[0]!.state, "failed");
    assert.equal(g.reports, 1);
    g.printers = [{ name: "Thermal", isDefault: true }];
    await g.engine.retry(job.id);
    assert.equal(g.prints, 1);
    assert.deepEqual(
      g.queue.all().map((j) => [j.attempt, j.state]),
      [
        [1, "failed"],
        [2, "printed"],
      ],
    );
  } finally {
    await g.close();
  }
});
test("revocation stops before the OS call and concurrent syncs print only once", async () => {
  const f = await fixture();
  try {
    f.revoked = true;
    await f.engine.sync();
    assert.equal(f.prints, 0);
    assert.equal(f.engine.connected, false);
    f.revoked = false;
    f.advance();
    await Promise.all([f.engine.sync(), f.engine.sync(), f.engine.tick()]);
    assert.equal(f.prints, 1);
  } finally {
    await f.close();
  }
});

test("a cancellation arriving during printer enumeration wins before the OS call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omni-race-"));
  const queue = new PrintQueue(join(dir, "q.db"), "a");
  let prints = 0,
    lists = 0;
  const api: AgentApi = {
    status: async () => ({ id: job.id, name: "PC", labelPrinter: null, documentPrinter: null }),
    pending: async () => [job],
    download: async () => {
      const p = join(dir, "pdf");
      await writeFile(p, "%PDF-");
      return p;
    },
    result: async () => {},
    testPrint: async () => {},
    retry: async () => {},
  };
  const engine = new PrintEngine(queue, api, {
    list: async () => {
      if (++lists === 2) engine.cancel(job.id);
      return [{ name: "Thermal", isDefault: true }];
    },
    print: async () => {
      prints++;
    },
  });
  try {
    await engine.sync();
    assert.equal(prints, 0);
    assert.equal(queue.all()[0]!.state, "cancelled");
    assert.equal((await readdir(dir)).includes("pdf"), false);
  } finally {
    await engine.stop();
    queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});
