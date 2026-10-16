import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "socket.io-client", "pdf-to-printer", "electron-updater"],
  sourcemap: false,
});
await build({
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
await build({
  entryPoints: ["src/renderer/index.ts"],
  outfile: "dist/renderer.js",
  bundle: true,
  platform: "browser",
  format: "iife",
});
for (const file of ["app.css"]) await copyFile(`src/renderer/${file}`, `dist/${file}`);
// The source icon is a simple geometric monogram; no external images or fonts are downloaded.
function png(size, tray) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      const d = Math.hypot(x - size / 2, y - size / 2) / size;
      const ring = d > 0.2 && d < 0.34;
      const corner =
        Math.hypot(
          Math.max(Math.abs(x - size / 2) - size * 0.32, 0),
          Math.max(Math.abs(y - size / 2) - size * 0.32, 0),
        ) <
        size * 0.14;
      const c = tray
        ? ring
          ? [35, 43, 55, 255]
          : [0, 0, 0, 0]
        : ring
          ? [255, 255, 255, 255]
          : corner
            ? [30, 107, 140, 255]
            : [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) raw[i + k] = c[k];
    }
  const crc = (b) => {
    let n = 0xffffffff;
    for (const byte of b) {
      n ^= byte;
      for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    }
    return (n ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const type = Buffer.from(name);
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    type.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([type, data])), data.length + 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
await writeFile("dist/icon.png", png(512, false));
await writeFile("dist/tray.png", png(32, true));

const messages = JSON.parse(await readFile("messages/id.json", "utf8"));
const html = (await readFile("src/renderer/index.html", "utf8")).replace(/\{\{(\w+)\}\}/g, (_, key) => {
  const value = messages[key];
  if (typeof value !== "string") throw new Error(`Unknown message ${key}`);
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
});
await writeFile("dist/index.html", html);
