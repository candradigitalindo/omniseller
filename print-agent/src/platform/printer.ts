import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, type BrowserWindow } from "electron";
import { AgentError, type PrinterDriver } from "../core/types";

const run = promisify(execFile);

/** OS spooler acceptance is reported as printed; physical output cannot be guaranteed by either driver. */
export function systemPrinter(window: BrowserWindow, platform = process.platform): PrinterDriver {
  return {
    async list() {
      let defaultName: string | undefined;
      if (platform === "win32") {
        const { getDefaultPrinter } = await import("pdf-to-printer");
        defaultName = (await getDefaultPrinter())?.name;
      } else if (platform === "darwin") {
        const result = await run("/usr/bin/lpstat", ["-d"], {
          timeout: 10_000,
          env: { ...process.env, LC_ALL: "C", LANG: "C" },
        }).catch(() => ({ stdout: "" }));
        defaultName = result.stdout.trim().match(/^system default destination: (.+)$/)?.[1];
      }
      return (await window.webContents.getPrintersAsync()).map((p) => ({
        name: p.name,
        isDefault: p.name === defaultName,
      }));
    },
    async print(file, printer, copies) {
      if (platform === "win32") {
        const { print } = await import("pdf-to-printer");
        const sumatraPdfPath = app.isPackaged
          ? join(process.resourcesPath, "sumatra", "SumatraPDF.exe")
          : join(app.getAppPath(), ".local", "vendor", "SumatraPDF.exe");
        await print(file, { printer, copies, silent: true, printDialog: false, scale: "noscale", sumatraPdfPath });
      } else if (platform === "darwin") {
        // execFile passes arguments directly: printer names never become shell commands.
        await run("/usr/bin/lp", ["-d", printer, "-n", String(copies), "-o", "fit-to-page=false", "--", file], {
          timeout: 60_000,
          windowsHide: true,
        });
      } else throw new AgentError("printer_missing");
    },
  };
}
