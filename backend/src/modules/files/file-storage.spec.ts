import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileStorage, R2FileStorage } from "./file-storage";

/** A tiny S3 stand-in: path-style object PUT, GET, DELETE, with what each request carried. */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; type: string | undefined }>();
  const requests: {
    method: string;
    path: string;
    auth: string | undefined;
    headers: Record<string, string | string[] | undefined>;
  }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://s3").pathname;
      requests.push({ method: req.method ?? "", path, auth: req.headers.authorization, headers: req.headers });
      if (req.method === "PUT") {
        objects.set(path, { body: Buffer.concat(chunks), type: req.headers["content-type"] });
        res.writeHead(200, { etag: '"x"' }).end();
      } else if (req.method === "GET") {
        const o = objects.get(path);
        if (!o) res.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
        else res.writeHead(200, { "content-type": o.type ?? "application/octet-stream" }).end(o.body);
      } else if (req.method === "DELETE") {
        objects.delete(path);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
  return { server, objects, requests };
}

describe("R2FileStorage (S3 API, path-style)", () => {
  const s3 = fakeS3();
  let storage: R2FileStorage;

  beforeAll(async () => {
    await new Promise<void>((r) => s3.server.listen(0, "127.0.0.1", r));
    const { port } = s3.server.address() as AddressInfo;
    storage = new R2FileStorage("omniseller-documents", {
      endpoint: `http://127.0.0.1:${port}`,
      accessKeyId: "omniseller",
      secretAccessKey: "omniseller-minio",
    });
  });
  afterAll(() => new Promise<void>((r) => (s3.server as Server).close(() => r())));

  it("puts, reads, and deletes objects in the bucket with signed requests", async () => {
    const key = "t/01TENANT/label/01FILE.pdf";
    await storage.put(key, new TextEncoder().encode("%PDF-1.4 label"), "application/pdf");
    expect(s3.objects.get(`/omniseller-documents/${key}`)).toMatchObject({ type: "application/pdf" });
    expect(new TextDecoder().decode(await storage.get(key))).toBe("%PDF-1.4 label");
    await storage.delete(key);
    expect(s3.objects.size).toBe(0);
    expect(s3.requests.every((r) => r.auth?.startsWith("AWS4-HMAC-SHA256 Credential=omniseller/"))).toBe(true);
  });

  it("streams a file from disk as the object's exact bytes", async () => {
    const dir = await mkdtemp(join(resolve(__dirname, "../../../.local"), "s3-put-"));
    try {
      const path = join(dir, "export.zip");
      const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 7); // larger than one stream chunk
      bytes.write("PK", 0);
      await writeFile(path, bytes);
      const key = "t/01TENANT/export/01FILE.zip";
      await storage.putFile(key, path, "application/zip");
      const stored = s3.objects.get(`/omniseller-documents/${key}`);
      expect(stored?.type).toBe("application/zip");
      expect(stored?.body.equals(bytes)).toBe(true);
      const put = s3.requests.filter((r) => r.method === "PUT").at(-1)!;
      expect(put.headers["content-length"]).toBe(String(bytes.length));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("signs download links for 10 minutes with the file name and type", async () => {
    const url = new URL(
      await storage.signedUrl("t/01TENANT/pick_list/01FILE.pdf", {
        filename: "pick-list-01file.pdf",
        mime: "application/pdf",
        ttlSeconds: 600,
      }),
    );
    expect(url.pathname).toBe("/omniseller-documents/t/01TENANT/pick_list/01FILE.pdf");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("response-content-disposition")).toBe('inline; filename="pick-list-01file.pdf"');
    expect(url.searchParams.get("response-content-type")).toBe("application/pdf");
    const zip = new URL(
      await storage.signedUrl("t/01TENANT/export/01FILE.zip", {
        filename: "omniseller-ekspor.zip",
        mime: "application/zip",
        ttlSeconds: 600,
        disposition: "attachment",
      }),
    );
    expect(zip.searchParams.get("response-content-disposition")).toBe('attachment; filename="omniseller-ekspor.zip"');
  });
});

describe("LocalFileStorage", () => {
  let dir: string;
  beforeAll(async () => {
    const base = resolve(__dirname, "../../../.local");
    await mkdir(base, { recursive: true });
    dir = await mkdtemp(join(base, "files-spec-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("keeps files under its directory and serves them through the api", async () => {
    const storage = new LocalFileStorage(dir);
    await storage.put("t/01T/label/a.pdf", new TextEncoder().encode("%PDF"), "application/pdf");
    expect(new TextDecoder().decode(await storage.get("t/01T/label/a.pdf"))).toBe("%PDF");
    expect(await storage.signedUrl()).toBeNull();
    await storage.delete("t/01T/label/a.pdf");
    await expect(storage.get("t/01T/label/a.pdf")).rejects.toThrow();
    await expect(storage.put("../escape.pdf", new Uint8Array([1]), "application/pdf")).rejects.toThrow(/outside/);
  });
});
