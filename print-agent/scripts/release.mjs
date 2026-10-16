import { spawnSync } from "node:child_process";

const url = new URL(process.env.PRINT_AGENT_UPDATE_URL ?? "");
if (url.protocol !== "https:" || url.username || url.password)
  throw new Error("PRINT_AGENT_UPDATE_URL must use HTTPS without credentials");
if (!["win32", "darwin"].includes(process.platform)) throw new Error("Release builds require Windows or macOS");
const required =
  process.platform === "win32"
    ? ["WIN_PUBLISHER_NAME", "CSC_LINK", "CSC_KEY_PASSWORD"]
    : ["MAC_SIGNING_IDENTITY", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);
const result = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  [
    "exec",
    "electron-builder",
    "--config",
    "electron-builder.release.yml",
    "--publish",
    "never",
    ...(process.platform === "win32" ? ["--win", "--x64"] : ["--mac", "--arm64"]),
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);
process.exitCode = result.status ?? 1;
