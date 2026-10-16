import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { unzipSync } from "fflate";

const lock = JSON.parse(await readFile("resources/sumatra/lock.json", "utf8"));
const directory = ".local/vendor";
await mkdir(directory, { recursive: true });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function verified(url, checksum, path, limit) {
  const cached = await readFile(path).catch(() => null);
  if (cached && digest(cached) === checksum) return cached;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error("SumatraPDF download failed");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("SumatraPDF download too large");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (digest(bytes) !== checksum) throw new Error("SumatraPDF checksum mismatch");
  await writeFile(path, bytes);
  return bytes;
}
const path = `${directory}/SumatraPDF.exe`;
const cached = await readFile(path).catch(() => null);
if (!cached || digest(cached) !== lock.executableSha256) {
  const archive = await verified(lock.url, lock.sha256, `${directory}/sumatra.zip`, 20 * 1024 * 1024);
  const executable = unzipSync(archive)[lock.file];
  if (!executable || digest(executable) !== lock.executableSha256)
    throw new Error("SumatraPDF executable checksum mismatch");
  await writeFile(path, executable);
}
if (process.argv.includes("--source")) {
  const path = `${directory}/SumatraPDF-${lock.version}-source.tar.gz`;
  await verified(lock.sourceArchive, lock.sourceSha256, path, 200 * 1024 * 1024);
  await mkdir("release", { recursive: true });
  await copyFile(path, `release/SumatraPDF-${lock.version}-source.tar.gz`);
}
