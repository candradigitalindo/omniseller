import { build } from "esbuild";

await build({
  entryPoints: ["test/electron-main.ts"],
  outfile: ".local/electron-test/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "socket.io-client", "pdf-to-printer", "electron-updater"],
});
