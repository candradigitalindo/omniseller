import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, expect, test } from "@playwright/test";
import { Server } from "socket.io";
import type { RemoteJob } from "../src/core/types";

const token = "A".repeat(43),
  id = "01K6MQB3P30000000000000001";
test("desktop pairs, saves printers, catches up without duplicate prints, and recovers an interrupted print", async ({
  playwright: _playwright,
}, info) => {
  const dir = await mkdtemp(join(tmpdir(), "omni-desktop-"));
  const preferences = {
    name: "PC Gudang",
    labelPrinter: null as string | null,
    documentPrinter: null as string | null,
  };
  let jobs: RemoteJob[] = [];
  let reports = 0;
  let rejectReport = true;
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/socket.io")) return;
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/v1/agent/status") {
      const input = JSON.parse(body);
      for (const k of ["labelPrinter", "documentPrinter", "name"] as const)
        if (input[k] !== undefined) preferences[k] = input[k];
      json({ id, ...preferences });
    } else if (req.url === "/v1/agent/print-jobs") json({ items: jobs });
    else if (req.url?.includes("/file?")) {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("%PDF-1.7\nTest document");
    } else if (req.url?.endsWith("/result")) {
      reports++;
      if (rejectReport) {
        rejectReport = false;
        json({}, 503);
      } else {
        jobs = [];
        json({ id, status: "printed" });
      }
    } else if (req.url?.endsWith("/retry")) {
      jobs = [
        {
          id,
          attempt: 3,
          kind: "label",
          title: "",
          printer: "Thermal",
          copies: 1,
          createdAt: "2026-10-16T00:00:00.000Z",
        },
      ];
      json({ id, status: "queued" });
    } else if (req.url === "/v1/agent/test-print") {
      json({ id, status: "queued" }, 201);
    } else json({}, 404);
  });
  const socket = new Server(server, { transports: ["websocket"] });
  socket.use((client, next) => next(client.handshake.auth.token === token ? undefined : new Error("unauthorized")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...environment } = process.env;
  const launch = () =>
    _electron.launch({
      args: [resolve(".local/electron-test/main.cjs")],
      env: { ...environment, AGENT_TEST_DIRECTORY: dir },
    });
  let desktop = await launch();
  try {
    let page = await desktop.firstWindow();
    await expect(page.locator("#pair-button")).toBeVisible();
    await page.screenshot({ path: info.outputPath("pairing.png") });
    expect(
      await page.evaluate(() => [
        typeof (window as unknown as { require: unknown }).require,
        typeof (window as unknown as { process: unknown }).process,
      ]),
    ).toEqual(["undefined", "undefined"]);
    await page.locator("#origin").fill(origin);
    await page.locator("#token").fill(token);
    await page.locator("#pair-button").click();
    await expect(page.locator("#agent-name")).toHaveText("PC Gudang");
    await page.locator("#settings summary").click();
    await page.locator("#computer-name").fill("PC Packing Jakarta");
    await page.locator("#computer-name").dispatchEvent("change");
    await page.locator("#label-printer").selectOption("Thermal");
    await page.locator("#document-printer").selectOption("A4 Office");
    await page.locator("#printers-form button").click();
    await expect(page.locator("#agent-name")).toHaveText("PC Packing Jakarta");
    expect(preferences).toEqual({ name: "PC Packing Jakarta", labelPrinter: "Thermal", documentPrinter: "A4 Office" });
    expect((await readFile(join(dir, "credentials.enc"))).includes(Buffer.from(token))).toBe(false);
    expect(await page.evaluate(async () => JSON.stringify(await window.printAgent.snapshot()))).not.toContain(token);
    expect(
      await page.evaluate(async () => {
        try {
          await fetch("https://example.test/");
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    jobs = [
      {
        id,
        attempt: 1,
        kind: "label",
        title: "Buyer text never stored",
        printer: "Thermal",
        copies: 2,
        createdAt: "2026-10-16T00:00:00.000Z",
      },
    ];
    socket.emit("print.job", jobs[0]);
    socket.emit("print.job", jobs[0]);
    await expect.poll(() => reports).toBe(1);
    await page.locator("#refresh").click();
    await expect.poll(() => reports).toBe(2);
    const prints = async () => (await readFile(join(dir, "prints.jsonl"), "utf8")).trim().split("\n");
    expect(await prints()).toHaveLength(1);
    await expect.poll(async () => readdir(join(dir, "pdf"))).toEqual([]);
    await page.locator("#settings summary").click();
    await page.screenshot({ path: info.outputPath("paired.png"), fullPage: true });
    // A new server retry is a new occurrence; a duplicate push of it still prints once.
    jobs = [
      {
        id,
        attempt: 2,
        kind: "label",
        title: "",
        printer: "A4 Office",
        copies: 1,
        createdAt: "2026-10-16T00:00:00.000Z",
      },
    ];
    await writeFile(join(dir, "hold-print"), "");
    socket.emit("print.job", jobs[0]);
    await expect.poll(async () => (await prints()).length).toBe(2);
    desktop.process().kill("SIGKILL");
    await new Promise<void>((r) => desktop.process().once("exit", () => r()));
    await rm(join(dir, "hold-print"));
    desktop = await launch();
    page = await desktop.firstWindow();
    await expect(page.getByText("Perlu diperiksa", { exact: true })).toBeVisible();
    expect(await prints()).toHaveLength(2);
    await page.getByRole("button", { name: "Belum tercetak", exact: true }).click();
    await page.locator('#confirm button[value="yes"]').click();
    await expect.poll(() => reports).toBe(3);
    expect(await prints()).toHaveLength(2);
    await page.getByRole("button", { name: "Cetak ulang", exact: true }).click();
    await page.locator('#confirm button[value="yes"]').click();
    await expect.poll(() => reports).toBe(4);
    expect(await prints()).toHaveLength(3);
    expect((await readFile(join(dir, "queue.db"))).includes(Buffer.from("Buyer text never stored"))).toBe(false);
    await page.locator("#unpair").click();
    await page.locator('#confirm button[value="yes"]').click();
    await expect(page.locator("#pair-button")).toBeVisible();
    await expect
      .poll(async () =>
        readFile(join(dir, "credentials.enc")).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
  } finally {
    await desktop.close().catch(() => {});
    await new Promise<void>((r) => socket.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
