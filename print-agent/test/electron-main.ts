/** Test-only entry: this file and its deterministic key never enter dist/ or the installer. */
import { createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { startDesktop } from "../src/application";

const directory = process.env.AGENT_TEST_DIRECTORY!;
app.setPath("userData", directory);
const key = Buffer.alloc(32, 123),
  iv = Buffer.alloc(12, 41);
void startDesktop({
  assets: join(__dirname, "../../dist"),
  directory,
  hidden: true,
  secure: {
    available: () => true,
    encrypt(value) {
      const c = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([c.update(value), c.final(), c.getAuthTag()]);
    },
    decrypt(value) {
      const c = createDecipheriv("aes-256-gcm", key, iv);
      c.setAuthTag(value.subarray(-16));
      return Buffer.concat([c.update(value.subarray(0, -16)), c.final()]).toString();
    },
  },
  driver: () => ({
    list: async () => [
      { name: "Thermal", isDefault: true },
      { name: "A4 Office", isDefault: false },
    ],
    print: async (file, printer, copies) => {
      if (!(await readFile(file, "utf8")).startsWith("%PDF-")) throw new Error("not PDF");
      await appendFile(join(directory, "prints.jsonl"), `${JSON.stringify({ printer, copies })}\n`);
      if (existsSync(join(directory, "hold-print"))) await new Promise<void>(() => {});
    },
  }),
}).catch(() => app.exit(1));
