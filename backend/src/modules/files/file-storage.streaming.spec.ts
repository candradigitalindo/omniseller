import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fileRangeSize,
  LocalFileStorage,
  MAX_FILE_RANGE_BYTES,
  MAX_STREAM_FILE_BYTES,
  R2FileStorage,
} from "./file-storage";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function local() {
  const dir = await mkdtemp(join(tmpdir(), "omniseller-stream-storage-"));
  temporary.push(dir);
  return { dir, storage: new LocalFileStorage(dir) };
}
function r2(output: unknown) {
  const storage = new R2FileStorage("documents", {
    endpoint: "https://r2.example.test",
    accessKeyId: "test-id",
    secretAccessKey: "test-secret",
  });
  const client = (storage as unknown as { s3: { send(command: unknown): Promise<unknown> } }).s3;
  const send = vi.spyOn(client, "send").mockResolvedValue(output);
  return { storage, send };
}

describe("bounded streaming file storage", () => {
  it("streams local bytes with backpressure and preserves their exact contents", async () => {
    const { dir, storage } = await local();
    const size = 3 * 1024 * 1024 + 11;
    const hash = createHash("sha256");
    let produced = 0;
    const stream = Readable.from(
      (async function* () {
        while (produced < size) {
          const chunk = Buffer.alloc(Math.min(65536, size - produced), produced % 251);
          hash.update(chunk);
          produced += chunk.length;
          yield chunk;
        }
      })(),
    );
    await storage.putStream("t/tenant/other/media.mp4", stream, "video/mp4", size);
    const stored = await readFile(join(dir, "t/tenant/other/media.mp4"));
    expect(stored.length).toBe(size);
    expect(createHash("sha256").update(stored).digest("hex")).toBe(hash.digest("hex"));
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_STREAM_FILE_BYTES + 1])(
    "rejects invalid declared stream size %s before writing",
    async (size) => {
      const { storage } = await local();
      await expect(
        storage.putStream("t/tenant/other/media.mp4", Readable.from([Buffer.from("data")]), "video/mp4", size),
      ).rejects.toThrow(/invalid streaming file size/);
    },
  );

  it("accepts the 500 MiB boundary as a stream declaration but rejects a short producer without allocating it", async () => {
    const { storage } = await local();
    await expect(
      storage.putStream(
        "t/tenant/other/media.mp4",
        Readable.from([Buffer.from("data")]),
        "video/mp4",
        MAX_STREAM_FILE_BYTES,
      ),
    ).rejects.toThrow(/shorter/);
    await expect(storage.get("t/tenant/other/media.mp4")).rejects.toThrow();
  });

  it.each([
    { bytes: "short", declared: 9 },
    { bytes: "too long", declared: 3 },
  ])("rejects length mismatch and removes the partial local object %#", async ({ bytes, declared }) => {
    const { storage } = await local();
    await expect(
      storage.putStream("t/tenant/other/media.mp4", Readable.from([Buffer.from(bytes)]), "video/mp4", declared),
    ).rejects.toThrow(/declared size/);
    await expect(storage.get("t/tenant/other/media.mp4")).rejects.toThrow();
  });

  it("uses half-open ranges, including the last byte, without reading the whole 500 MiB file", async () => {
    const { dir, storage } = await local();
    await storage.put("t/tenant/other/small.bin", new Uint8Array([0, 1, 2, 3, 4, 5, 6]), "application/octet-stream");
    expect(new Uint8Array(await storage.getRange("t/tenant/other/small.bin", 2, 6))).toEqual(
      new Uint8Array([2, 3, 4, 5]),
    );
    expect(new Uint8Array(await storage.getRange("t/tenant/other/small.bin", 6, 7))).toEqual(new Uint8Array([6]));
    const path = join(dir, "large-sparse.bin");
    const sparse = await open(path, "w");
    await sparse.truncate(MAX_STREAM_FILE_BYTES);
    await sparse.write(Buffer.from("tail"), 0, 4, MAX_STREAM_FILE_BYTES - 4);
    await sparse.close();
    expect(await storage.getRange("large-sparse.bin", MAX_STREAM_FILE_BYTES - 4, MAX_STREAM_FILE_BYTES)).toEqual(
      Buffer.from("tail"),
    );
  });

  it.each([
    [-1, 1],
    [1, 1],
    [3, 2],
    [0, MAX_FILE_RANGE_BYTES + 1],
    [0, Number.POSITIVE_INFINITY],
    [0.5, 2],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ])("refuses invalid/unbounded byte range %s to %s", async (start, end) => {
    const { storage } = await local();
    await expect(storage.getRange("missing", start, end)).rejects.toThrow(/invalid file byte range/);
  });

  it("accepts a 30 MiB range bound and refuses a range beyond actual local bytes", async () => {
    expect(fileRangeSize(0, MAX_FILE_RANGE_BYTES)).toBe(MAX_FILE_RANGE_BYTES);
    const { storage } = await local();
    await storage.put("short", Buffer.from("abc"), "application/octet-stream");
    await expect(storage.getRange("short", 1, 5)).rejects.toThrow(/shorter/);
    await expect(storage.getRange("../outside", 0, 1)).rejects.toThrow(/outside/);
  });

  it("sends an S3 Range header with inclusive wire end and consumes exactly the bounded response", async () => {
    const { storage, send } = r2({
      $metadata: { httpStatusCode: 206 },
      ContentRange: "bytes 5-8/100",
      ContentLength: 4,
      Body: Readable.from([Buffer.from("ab"), Buffer.from("cd")]),
    });
    expect(await storage.getRange("t/tenant/other/media.mp4", 5, 9)).toEqual(Buffer.from("abcd"));
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input.Range).toBe("bytes=5-8");
  });

  it.each([
    { status: 200, range: "bytes 5-8/100", length: 4 },
    { status: 206, range: "bytes 0-99/100", length: 100 },
    { status: 206, range: "bytes 5-8/8", length: 4 },
    { status: 206, range: undefined, length: 4 },
    { status: 206, range: "bytes 5-8/100", length: undefined },
  ])("rejects an ignored/mismatched S3 range before reading its body %#", async ({ status, range, length }) => {
    let reads = 0;
    const body = Readable.from(
      (async function* () {
        reads++;
        yield Buffer.from("never load a whole file");
      })(),
    );
    const { storage } = r2({
      $metadata: { httpStatusCode: status },
      ContentRange: range,
      ContentLength: length,
      Body: body,
    });
    await expect(storage.getRange("t/tenant/other/media.mp4", 5, 9)).rejects.toThrow(/requested byte range/);
    expect(reads).toBe(0);
    expect(body.destroyed).toBe(true);
  });

  it.each(["abc", "abcde"])("rejects a dishonest S3 response body of length %s", async (text) => {
    const { storage } = r2({
      $metadata: { httpStatusCode: 206 },
      ContentRange: "bytes 5-8/100",
      ContentLength: 4,
      Body: Readable.from([Buffer.from(text)]),
    });
    await expect(storage.getRange("key", 5, 9)).rejects.toThrow(/shorter|exceeds/);
  });

  it("passes a stream and exact ContentLength to S3 instead of a complete in-memory body", async () => {
    const { storage, send } = r2({});
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 3, 17);
    let consumed = Buffer.alloc(0);
    send.mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      const input = (command as PutObjectCommand).input;
      expect(input.ContentLength).toBe(bytes.length);
      expect(input.Body).toBeInstanceOf(Readable);
      const parts: Buffer[] = [];
      for await (const chunk of input.Body as Readable) parts.push(chunk as Buffer);
      consumed = Buffer.concat(parts);
      return {};
    });
    await storage.putStream(
      "t/tenant/other/media.mp4",
      Readable.from([bytes.subarray(0, 65536), bytes.subarray(65536)]),
      "video/mp4",
      bytes.length,
    );
    expect(consumed.equals(bytes)).toBe(true);
  });
});
