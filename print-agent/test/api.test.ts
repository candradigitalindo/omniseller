import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HttpAgentApi, validateOrigin } from "../src/core/api";
import { AgentError } from "../src/core/types";

const job = { id: "01K6MQB3P30000000000000001", attempt: 2 };
test("production API origin requires HTTPS; development HTTP is loopback only", () => {
  assert.equal(validateOrigin(" https://api.example.test/ "), "https://api.example.test");
  for (const value of [
    "http://api.example.test",
    "https://user:password@example.test",
    "https://example.test/path",
    "https://example.test/?token=x",
    "https://example.test/#x",
    "file:///a",
  ])
    assert.throws(() => validateOrigin(value));
  assert.throws(() => validateOrigin("http://192.168.1.1", true));
  assert.equal(validateOrigin("http://127.0.0.1:3000", true), "http://127.0.0.1:3000");
});
test("signed file redirects never receive the device token, even on a second hop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omni-api-"));
  const calls: { url: string; token: string | null }[] = [];
  const request: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), token: new Headers(init?.headers).get("authorization") });
    if (calls.length === 1)
      return new Response(null, { status: 302, headers: { location: "https://storage.test/label?signature=secret" } });
    if (calls.length === 2) return new Response(null, { status: 307, headers: { location: "/redirected" } });
    return new Response("%PDF-1.7\nprivate buyer information", { headers: { "content-type": "application/pdf" } });
  };
  try {
    const api = new HttpAgentApi("https://api.test", "secret-device-token", "0.1.0", dir, false, request);
    const path = await api.download(job);
    assert.equal((await readFile(path, "utf8")).startsWith("%PDF-"), true);
    assert.deepEqual(
      calls.map((c) => c.token),
      ["Bearer secret-device-token", null, null],
    );
    assert.match(calls[0]!.url, /attempt=2$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("invalid and oversized files leave no local buyer data; untrusted redirects and revoked tokens are refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omni-api-"));
  try {
    for (const response of [
      new Response("not a PDF"),
      new Response("", { headers: { "content-length": String(51 * 1024 * 1024) } }),
      new Response(null, { status: 302, headers: { location: "http://insecure.test/a.pdf" } }),
      new Response(null, { status: 401 }),
    ]) {
      const api = new HttpAgentApi("https://api.test", "secret", "0.1.0", dir, false, async () => response);
      await assert.rejects(api.download(job), AgentError);
      assert.deepEqual(await readdir(dir), []);
    }
    const request: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("%PDF-"));
            controller.error(new Error("offline"));
          },
        }),
      );
    await assert.rejects(new HttpAgentApi("https://api.test", "secret", "0.1.0", dir, false, request).download(job));
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("pending list strips titles, validates attempts, and handles split UTF-8 in status JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omni-api-"));
  try {
    const remote = {
      ...job,
      kind: "label",
      title: "Private buyer",
      printer: null,
      copies: 1,
      createdAt: "2026-10-16T00:00:00.000Z",
    };
    const api = new HttpAgentApi("https://api.test", "secret", "0.1.0", dir, false, async () =>
      Response.json({ items: [remote] }),
    );
    assert.equal((await api.pending())[0]!.title, "");
    const bad = new HttpAgentApi("https://api.test", "secret", "0.1.0", dir, false, async () =>
      Response.json({ items: [{ ...remote, attempt: 0 }] }),
    );
    await assert.rejects(bad.pending());
    const bytes = new TextEncoder().encode(
      JSON.stringify({ id: job.id, name: "PC 日本", labelPrinter: null, documentPrinter: null }),
    );
    const split = new HttpAgentApi(
      "https://api.test",
      "secret",
      "0.1.0",
      dir,
      false,
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
              c.close();
            },
          }),
        ),
    );
    assert.equal((await split.status([])).name, "PC 日本");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
