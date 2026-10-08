#!/usr/bin/env node
/**
 * Previews dist/ the way a static host serves it: "/harga/" is harga/index.html, and an unknown address
 * gets 404.html. Local only (127.0.0.1). `node serve.mjs [port]`, default 4173.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("./dist/", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};
const port = Number(process.argv[2] ?? 4173);

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  let file = normalize(join(DIST, path));
  if (!file.startsWith(DIST)) return void res.writeHead(400).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  const found = existsSync(file);
  const served = found ? file : join(DIST, "404.html");
  res.writeHead(found ? 200 : 404, { "content-type": TYPES[extname(served)] ?? "application/octet-stream" });
  res.end(readFileSync(served));
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}`));
