import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { newId } from "@omniseller/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { LocalFileStorage, MAX_FILE_RANGE_BYTES, MAX_STREAM_FILE_BYTES } from "./file-storage";
import type { FileRow, FilesRepository } from "./files.repository";
import { FilesService } from "./files.service";

const transactions = vi.hoisted(() => ({ active: 0, calls: 0 }));
vi.mock("../../db/tenant-tx", () => ({
  withTenantTx: vi.fn(
    async (_db: unknown, ctx: { tenantId: string }, fn: (tx: { tenantId: string }) => Promise<unknown>) => {
      transactions.active++;
      transactions.calls++;
      try {
        return await fn({ tenantId: ctx.tenantId });
      } finally {
        transactions.active--;
      }
    },
  ),
}));
const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  transactions.active = 0;
  transactions.calls = 0;
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "omniseller-files-service-"));
  temporary.push(dir);
  const storage = new LocalFileStorage(dir);
  const rows = new Map<string, FileRow>();
  const repo = {
    insert: vi.fn(async (tx: { tenantId: string }, input: Omit<FileRow, "createdAt" | "updatedAt" | "rowVersion">) => {
      expect(tx.tenantId).toBe(input.tenantId);
      const row = { createdAt: new Date(), updatedAt: new Date(), rowVersion: 1, ...input };
      rows.set(row.id, row);
      return row;
    }),
    get: vi.fn(async (tx: { tenantId: string }, id: string) => {
      const row = rows.get(id);
      return row?.tenantId === tx.tenantId ? row : undefined;
    }),
  };
  const service = new FilesService({} as DbHandle, repo as unknown as FilesRepository, storage);
  const ctx = systemContext(newId());
  return { dir, storage, rows, repo, service, ctx };
}
const input = () => ({
  purpose: "other" as const,
  mime: "video/mp4",
  ext: "mp4",
  expiresAt: new Date(Date.now() + 3_600_000),
});

describe("FilesService bounded streaming", () => {
  it("streams a spooled file, hashes exact bytes and writes metadata only after storage completes", async () => {
    const h = await harness();
    const secret = "PII-canary-local-file-never-logged";
    const path = join(h.dir, secret);
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 15);
    bytes.write(secret);
    await writeFile(path, bytes);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = h.storage.putStream.bind(h.storage);
    let stored = false;
    vi.spyOn(h.storage, "putStream").mockImplementation(async (...args) => {
      expect(transactions.active).toBe(0);
      expect(h.repo.insert).not.toHaveBeenCalled();
      expect(args[1]).toBeInstanceOf(Readable);
      expect(args[3]).toBe(bytes.length);
      await original(...args);
      stored = true;
    });
    h.repo.insert.mockImplementationOnce(async (_tx, row) => {
      expect(stored).toBe(true);
      const result = { createdAt: new Date(), updatedAt: new Date(), rowVersion: 1, ...row };
      h.rows.set(result.id, result);
      return result;
    });
    const row = await h.service.saveFromLocalFile(h.ctx, { ...input(), path, sizeBytes: bytes.length });
    expect(row.objectKey).toMatch(new RegExp(`^t/${h.ctx.tenantId}/other/[A-Z0-9]+\\.mp4$`));
    expect(row.objectKey).not.toContain(secret);
    expect(row.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(row.sizeBytes).toBe(bytes.length);
    expect((await readFile(join(h.dir, row.objectKey))).equals(bytes)).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_STREAM_FILE_BYTES + 1])(
    "rejects an invalid stream declaration %s and closes its source before persistence",
    async (sizeBytes) => {
      const h = await harness();
      const source = Readable.from([Buffer.from("data")]);
      const put = vi.spyOn(h.storage, "putStream");
      await expect(h.service.saveStream(h.ctx, { ...input(), stream: source, sizeBytes })).rejects.toMatchObject({
        code: "validation.failed",
      });
      expect(source.destroyed).toBe(true);
      expect(put).not.toHaveBeenCalled();
      expect(transactions.calls).toBe(0);
    },
  );

  it("verifies the spooled byte count and file extension before writing an object", async () => {
    const h = await harness();
    const path = join(h.dir, "spooled");
    await writeFile(path, "data");
    const put = vi.spyOn(h.storage, "putStream");
    await expect(h.service.saveFromLocalFile(h.ctx, { ...input(), path, sizeBytes: 3 })).rejects.toMatchObject({
      code: "validation.failed",
    });
    await expect(h.service.saveFromLocalFile(h.ctx, { ...input(), ext: "../../outside", path })).rejects.toMatchObject({
      code: "validation.failed",
    });
    expect(put).not.toHaveBeenCalled();
    expect(transactions.calls).toBe(0);
  });

  it("does not persist a short, overlong or failing stream and removes its partial object", async () => {
    for (const source of [
      Readable.from([Buffer.from("abc")]),
      Readable.from([Buffer.from("abcdef")]),
      Readable.from(
        (async function* () {
          yield Buffer.from("ab");
          throw new Error("stream unavailable");
        })(),
      ),
    ]) {
      const h = await harness();
      const deletion = vi.spyOn(h.storage, "delete");
      await expect(h.service.saveStream(h.ctx, { ...input(), stream: source, sizeBytes: 4 })).rejects.toThrow();
      expect(h.repo.insert).not.toHaveBeenCalled();
      expect(transactions.calls).toBe(0);
      expect(deletion).toHaveBeenCalledTimes(1);
      await expect(h.storage.get(deletion.mock.calls[0]![0])).rejects.toThrow();
    }
  });

  it("retains an uploaded object when the database commit outcome is uncertain", async () => {
    const h = await harness();
    h.repo.insert.mockRejectedValueOnce(new Error("database unavailable"));
    const deletion = vi.spyOn(h.storage, "delete");
    const put = vi.spyOn(h.storage, "putStream");
    await expect(
      h.service.saveStream(h.ctx, { ...input(), stream: Readable.from([Buffer.from("data")]), sizeBytes: 4 }),
    ).rejects.toThrow(/database/);
    expect(deletion).not.toHaveBeenCalled();
    expect(Buffer.from(await h.storage.get(put.mock.calls[0]![0]))).toEqual(Buffer.from("data"));
  });

  it("preserves save(bytes) and saveFile(export) behavior alongside the new stream path", async () => {
    const h = await harness();
    const saved = await h.service.save(h.ctx, { ...input(), bytes: Buffer.from("old") });
    const path = join(h.dir, "export.zip");
    await writeFile(path, "export");
    const exported = await h.service.saveFile(h.ctx, { ...input(), purpose: "export", ext: "zip", path });
    expect(Buffer.from((await h.service.read(h.ctx, saved.id))!)).toEqual(Buffer.from("old"));
    expect(Buffer.from((await h.service.read(h.ctx, exported.id))!)).toEqual(Buffer.from("export"));
  });
});

describe("FilesService bounded private ranges", () => {
  it("uses half-open ranges and short tenant transactions outside storage reads", async () => {
    const h = await harness();
    const row = await h.service.save(h.ctx, { ...input(), bytes: new Uint8Array([0, 1, 2, 3, 4, 5]) });
    const original = h.storage.getRange.bind(h.storage);
    const get = vi.spyOn(h.storage, "getRange").mockImplementation(async (...args) => {
      expect(transactions.active).toBe(0);
      return original(...args);
    });
    expect(new Uint8Array(await h.service.readRange(h.ctx, row.id, 2, 5))).toEqual(new Uint8Array([2, 3, 4]));
    expect(get).toHaveBeenCalledWith(row.objectKey, 2, 5);
    expect(new Uint8Array(await h.service.readRange(h.ctx, row.id, 5, 6))).toEqual(new Uint8Array([5]));
  });

  it("refuses another tenant and expired files before reading private bytes", async () => {
    const h = await harness();
    const row = await h.service.save(h.ctx, { ...input(), bytes: Buffer.from("private") });
    const get = vi.spyOn(h.storage, "getRange");
    await expect(h.service.readRange(systemContext(newId()), row.id, 0, 2)).rejects.toMatchObject({
      code: "file.not_found",
    });
    h.rows.set(row.id, { ...row, expiresAt: new Date(Date.now() - 1) });
    expect(await h.service.metadata(h.ctx, row.id)).toBeNull();
    expect(await h.service.read(h.ctx, row.id)).toBeNull();
    await expect(h.service.readRange(h.ctx, row.id, 0, 2)).rejects.toMatchObject({ code: "file.not_found" });
    expect(get).not.toHaveBeenCalled();
  });

  it("checks the stored tenant prefix even if a repository returned a mismatched key", async () => {
    const h = await harness();
    const row = await h.service.save(h.ctx, { ...input(), bytes: Buffer.from("private") });
    h.rows.set(row.id, { ...row, objectKey: `t/${newId()}/other/wrong.mp4` });
    const get = vi.spyOn(h.storage, "getRange");
    await expect(h.service.readRange(h.ctx, row.id, 0, 2)).rejects.toMatchObject({ code: "file.not_found" });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    [-1, 1],
    [0, 0],
    [2, 1],
    [0, MAX_FILE_RANGE_BYTES + 1],
    [0, Number.NaN],
  ])("refuses malformed range %s to %s before querying metadata", async (start, end) => {
    const h = await harness();
    await expect(h.service.readRange(h.ctx, newId(), start, end)).rejects.toMatchObject({ code: "validation.failed" });
    expect(h.repo.get).not.toHaveBeenCalled();
  });

  it("rejects out-of-file bounds and unexpectedly short storage reads", async () => {
    const h = await harness();
    const row = await h.service.save(h.ctx, { ...input(), bytes: Buffer.from("abcd") });
    const get = vi.spyOn(h.storage, "getRange");
    await expect(h.service.readRange(h.ctx, row.id, 0, 5)).rejects.toMatchObject({ code: "validation.failed" });
    expect(get).not.toHaveBeenCalled();
    get.mockResolvedValueOnce(new Uint8Array([0]));
    await expect(h.service.readRange(h.ctx, row.id, 0, 3)).rejects.toMatchObject({ code: "file.range_incomplete" });
  });

  it("rechecks expiry after storage I/O instead of returning a file that expired during the read", async () => {
    const h = await harness();
    const row = await h.service.save(h.ctx, { ...input(), bytes: Buffer.from("abcd") });
    vi.spyOn(h.storage, "getRange").mockImplementationOnce(async () => {
      h.rows.set(row.id, { ...row, expiresAt: new Date(Date.now() - 1) });
      return Buffer.from("ab");
    });
    await expect(h.service.readRange(h.ctx, row.id, 0, 2)).rejects.toMatchObject({ code: "file.not_found" });
  });
});
