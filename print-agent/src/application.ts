import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, protocol, Tray } from "electron";
import { io, type Socket } from "socket.io-client";
import { z } from "zod";
import messages from "../messages/id.json";
import type { Action, Reply } from "./contracts";
import { HttpAgentApi, validateOrigin } from "./core/api";
import { PrintEngine } from "./core/engine";
import { PrintQueue } from "./core/queue";
import { AgentError, type AgentSnapshot, type ErrorCode, type PrinterDriver } from "./core/types";
import { CredentialStore, type Credentials, type SecretStorage } from "./platform/credentials";
import { systemPrinter } from "./platform/printer";

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const PAGE = "app://agent/index.html";
const nameSchema = z.string().min(1).max(200).nullable();
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("retry"), id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) }).strict(),
  z.object({ type: z.literal("pair"), origin: z.string().max(2000), token: z.string().regex(/^[\w-]{43}$/) }).strict(),
  z.object({ type: z.literal("pause"), paused: z.boolean() }).strict(),
  z
    .object({
      type: z.literal("printers"),
      preferences: z
        .object({
          labelPrinter: nameSchema,
          documentPrinter: nameSchema,
          name: z.string().trim().min(1).max(80).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("resolve"),
      id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      attempt: z.number().int().positive(),
      status: z.enum(["printed", "failed"]),
    })
    .strict(),
  ...["refresh", "unpair", "update", "quit", "test-print"].map((type) => z.object({ type: z.literal(type) }).strict()),
]);
export interface DesktopOptions {
  assets: string;
  directory: string;
  secure: SecretStorage;
  driver?: (window: BrowserWindow) => PrinterDriver;
  /** Only the separate test entry supplies this; it is not present in the distributed application. */
  hidden?: boolean;
}

export async function startDesktop(options: DesktopOptions): Promise<BrowserWindow> {
  await app.whenReady();
  const directory = options.directory;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pdfDirectory = join(directory, "pdf");
  await mkdir(pdfDirectory, { recursive: true, mode: 0o700 });
  for (const file of await readdir(pdfDirectory))
    if (/^[a-f0-9-]+\.pdf$/.test(file)) await rm(join(pdfDirectory, file), { force: true });
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const files: Record<string, string> = {
      "/index.html": "index.html",
      "/renderer.js": "renderer.js",
      "/app.css": "app.css",
    };
    const file = url.host === "agent" ? files[url.pathname] : undefined;
    return file ? net.fetch(pathToFileURL(join(options.assets, file)).toString()) : new Response(null, { status: 404 });
  });
  const window = new BrowserWindow({
    title: messages.app,
    width: 420,
    height: 560,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: "#F4F6F8",
    show: !options.hidden,
    icon: join(options.assets, "icon.png"),
    webPreferences: {
      preload: join(options.assets, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  const credentials = new CredentialStore(join(directory, "credentials.enc"), options.secure);
  const driver = options.driver?.(window) ?? systemPrinter(window);
  let binding: Credentials | null = null;
  let engine: PrintEngine | undefined;
  let socket: Socket | undefined;
  let uiError: ErrorCode | null = null;
  let updaterState = "updateDisabled";
  let cleaned = false;
  let shuttingDown = false;
  const snapshot = (): AgentSnapshot => ({
    paired: !!binding,
    origin: binding?.origin ?? "",
    name: engine?.self?.name ?? "",
    connected: engine?.connected ?? false,
    paused: engine?.paused ?? false,
    error: uiError ?? engine?.error ?? null,
    printers: engine?.printers ?? [],
    preferences: {
      labelPrinter: engine?.self?.labelPrinter ?? null,
      documentPrinter: engine?.self?.documentPrinter ?? null,
    },
    jobs: engine?.queue.all().slice(-100).reverse() ?? [],
    version: app.getVersion(),
    update: updaterState,
  });
  const changed = () => {
    if (!window.isDestroyed() && !shuttingDown) window.webContents.send("agent:state", snapshot());
  };
  const disconnect = async () => {
    socket?.disconnect();
    socket = undefined;
    const current = engine;
    await current?.stop();
    current?.queue.close();
    engine = undefined;
  };
  const connect = async (saved: Credentials) => {
    binding = saved;
    const api = new HttpAgentApi(saved.origin, saved.token, app.getVersion(), pdfDirectory, !app.isPackaged);
    const scope = createHash("sha256").update(`${saved.origin}\0${saved.deviceId}`).digest("hex");
    const current = new PrintEngine(new PrintQueue(join(directory, "queue.db"), scope), api, driver, changed);
    engine = current;
    socket = io(saved.origin, {
      transports: ["websocket"],
      auth: { token: saved.token },
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
    });
    socket.on("connect", () => {
      void current.sync();
    });
    // Events are hints only. Metadata and attempt numbers are re-read through the authenticated API.
    socket.on("print.job", () => {
      void current.sync();
    });
    socket.on("print.cancelled", (value: unknown) => {
      const parsed = z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) }).safeParse(value);
      if (parsed.success) current.cancel(parsed.data.id);
    });
    socket.on("connect_error", () => {
      /* REST catch-up remains available while realtime reconnects. */
    });
    socket.connect();
    await current.sync();
    changed();
  };
  const trusted = (event: Electron.IpcMainInvokeEvent) =>
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === PAGE;
  ipcMain.handle("agent:snapshot", (event) => {
    if (!trusted(event)) throw new Error("unauthorized");
    return snapshot();
  });
  let acting = false;
  ipcMain.handle("agent:action", async (event, input: unknown): Promise<Reply> => {
    if (!trusted(event) || acting || shuttingDown) return { ok: false, error: "request_rejected" };
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "request_rejected" };
    const action = parsed.data as Action;
    acting = true;
    uiError = null;
    try {
      if (action.type === "pair") {
        if (binding) throw new AgentError("request_rejected");
        const origin = validateOrigin(action.origin, !app.isPackaged);
        const api = new HttpAgentApi(origin, action.token, app.getVersion(), pdfDirectory, !app.isPackaged);
        const self = await api.status((await driver.list()).slice(0, 50));
        const saved = { origin, token: action.token, deviceId: self.id };
        await credentials.save(saved);
        await connect(saved);
      } else if (action.type === "unpair") {
        await disconnect();
        await credentials.clear();
        binding = null;
      } else if (action.type === "refresh") await engine?.sync();
      else if (action.type === "retry") {
        if (!engine?.queue.all().some((job) => job.id === action.id && job.state === "failed"))
          throw new AgentError("request_rejected");
        await engine.retry(action.id);
      } else if (action.type === "test-print") await engine?.testPrint();
      else if (action.type === "pause" && engine) {
        engine.paused = action.paused;
        await engine.tick();
      } else if (action.type === "printers" && engine) {
        await engine.sync(action.preferences);
        if (engine.error) throw new AgentError(engine.error);
      } else if (action.type === "resolve" && engine) {
        engine.resolve(action.id, action.attempt, action.status);
        await engine.tick();
      } else if (action.type === "update") await checkUpdate();
      else if (action.type === "quit") app.quit();
      changed();
      return { ok: true };
    } catch (error) {
      uiError = error instanceof AgentError ? error.code : "unknown";
      changed();
      return { ok: false, error: uiError };
    } finally {
      acting = false;
    }
  });
  let updateAction: (() => Promise<void>) | undefined;
  async function checkUpdate() {
    if (!updateAction) {
      updaterState = "updateDisabled";
      changed();
      return;
    }
    await updateAction();
  }
  if (app.isPackaged && existsSync(join(process.resourcesPath, "app-update.yml"))) {
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.logger = null;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => {
      updaterState = "updateChecking";
      changed();
    });
    autoUpdater.on("update-not-available", () => {
      updaterState = "updateCurrent";
      changed();
    });
    autoUpdater.on("update-available", () => {
      updaterState = "updateAvailable";
      changed();
    });
    autoUpdater.on("update-downloaded", () => {
      updaterState = "updateReady";
      changed();
    });
    autoUpdater.on("error", () => {
      updaterState = "updateFailed";
      changed();
    });
    updateAction = async () => {
      if (engine?.queue.all().some((j) => ["queued", "printing"].includes(j.state)))
        throw new AgentError("request_rejected");
      if (updaterState === "updateAvailable") await autoUpdater.downloadUpdate();
      else if (updaterState !== "updateReady") {
        await autoUpdater.checkForUpdates();
        if (
          updaterState === "updateAvailable" &&
          !engine?.queue.all().some((j) => ["queued", "printing"].includes(j.state))
        )
          await autoUpdater.downloadUpdate();
      }
    };
  }
  const interval = setInterval(() => {
    if (engine && !shuttingDown) void engine.tick();
  }, 1000);
  let lastUpdateCheck = 0;
  const heartbeat = setInterval(() => {
    if (engine && !shuttingDown) void engine.sync();
    if (updateAction && !shuttingDown && Date.now() - lastUpdateCheck > 4 * 3600_000) {
      lastUpdateCheck = Date.now();
      void checkUpdate().catch(() => {
        /* Retry at the next idle check; updater events show the safe error. */
      });
    }
  }, 60_000);
  const tray = new Tray(nativeImage.createFromPath(join(options.assets, "tray.png")));
  tray.setToolTip(messages.app);
  const show = () => {
    window.show();
    window.focus();
  };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: messages.show, click: show },
      { type: "separator" },
      { label: messages.quit, click: () => app.quit() },
    ]),
  );
  tray.on("click", show);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "OmniSeller",
        submenu: [
          { label: messages.show, click: show },
          { label: messages.quit, click: () => app.quit(), accelerator: "CmdOrCtrl+Q" },
        ],
      },
    ]),
  );
  window.on("close", (event) => {
    if (!shuttingDown) {
      event.preventDefault();
      window.hide();
    }
  });
  app.on("activate", show);
  app.on("before-quit", (event) => {
    if (cleaned) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(interval);
    clearInterval(heartbeat);
    void disconnect().finally(() => {
      tray.destroy();
      cleaned = true;
      app.quit();
    });
  });
  await window.loadURL(PAGE);
  try {
    const saved = await credentials.load();
    if (saved) {
      saved.origin = validateOrigin(saved.origin, !app.isPackaged);
      await connect(saved);
    }
  } catch {
    uiError = "storage";
    changed();
  }
  app.on("second-instance", show);
  return window;
}
