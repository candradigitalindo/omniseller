#!/usr/bin/env node
// Local development runner for the backend (backend doc 15.3).
// Compiles with `tsc --watch` (keeps decorator metadata for NestJS) and runs each requested process
// role with `node --watch`, prefixing its output. Usage from backend/: node tools/dev.mjs api worker
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const roles = process.argv.slice(2);
if (roles.length === 0) {
  process.stderr.write("usage: dev.mjs <api|webhook|worker|scheduler|research-collector>...\n");
  process.exit(1);
}

const colors = { api: 36, webhook: 35, worker: 33, scheduler: 32, "research-collector": 34, tsc: 90 };
const children = [];

function pipe(name, stream) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`\x1b[${colors[name] ?? 37}m${name.padEnd(10)}\x1b[0m ${line}\n`);
  });
}

function run(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  pipe(name, child.stdout);
  pipe(name, child.stderr);
  children.push(child);
  return child;
}

const envFile = existsSync(".env.local") ? ["--env-file=.env.local"] : [];
let started = false;

const tsc = run("tsc", "npx", ["tsc", "-w", "-p", "tsconfig.build.json", "--preserveWatchOutput"]);
tsc.stdout.on("data", (chunk) => {
  if (!started && /Found 0 errors/.test(chunk.toString())) {
    started = true;
    for (const role of roles) {
      run(role, process.execPath, [...envFile, "--enable-source-maps", "--watch", "dist/main.js"], {
        APP_ROLE: role,
        NODE_ENV: process.env.NODE_ENV ?? "local",
      });
    }
  }
});

function shutdown() {
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
