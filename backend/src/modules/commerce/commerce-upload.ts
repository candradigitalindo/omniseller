import { createWriteStream } from "node:fs";
import { lstat, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { defer, lastValueFrom, type Observable } from "rxjs";

const PREFIX = "omniseller-commerce-upload-";
interface Spool {
  path?: string;
  commerceTemporaryDirectory?: string;
  size: number;
  buffer?: Uint8Array;
}
export async function removeCommerceSpool(file: Spool | undefined) {
  if (
    file?.commerceTemporaryDirectory &&
    file.path === join(file.commerceTemporaryDirectory, "upload") &&
    file.commerceTemporaryDirectory.startsWith(join(tmpdir(), PREFIX))
  )
    await rm(file.commerceTemporaryDirectory, { recursive: true, force: true });
}
async function staleSpools() {
  const entries = (await readdir(tmpdir())).filter((name) => name.startsWith(PREFIX)).slice(0, 100);
  for (const name of entries) {
    const path = join(tmpdir(), name);
    const info = await lstat(path).catch(() => null);
    if (info?.isDirectory() && info.mtimeMs < Date.now() - 3_600_000) await rm(path, { recursive: true, force: true });
  }
}
@Injectable()
export class CommerceSpoolCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  onModuleInit() {
    void staleSpools().catch(() => undefined);
    this.timer = setInterval(() => {
      void staleSpools().catch(() => undefined);
    }, 15 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
/** Disk-backed multipart storage: bytes never live in a 500 MiB API buffer. */
export const commerceUploadStorage = {
  _handleFile(_request: unknown, file: { stream: Readable }, callback: (error: Error | null, info?: Spool) => void) {
    let directory: string | undefined;
    void (async () => {
      await staleSpools();
      directory = await mkdtemp(join(tmpdir(), PREFIX));
      const path = join(directory, "upload");
      let size = 0;
      file.stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
      });
      await pipeline(file.stream, createWriteStream(path, { flags: "wx", mode: 0o600 }));
      callback(null, { path, size, commerceTemporaryDirectory: directory });
    })().catch(async (error: Error) => {
      if (directory) await rm(directory, { recursive: true, force: true });
      callback(error);
    });
  },
  _removeFile(_request: unknown, file: Spool, callback: (error: Error | null) => void) {
    void removeCommerceSpool(file).then(
      () => callback(null),
      (error: Error) => callback(error),
    );
  },
};
/** Runs even when DTO validation or a service rejects the upload. */
@Injectable()
export class CommerceUploadCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ file?: Spool }>();
    return defer(async () => {
      try {
        return await lastValueFrom(next.handle());
      } finally {
        await removeCommerceSpool(request.file);
      }
    });
  }
}
export async function commerceUploadPrefix(file: Spool): Promise<Uint8Array> {
  if (file.buffer) return file.buffer.subarray(0, 4096);
  if (!file.path || !file.commerceTemporaryDirectory || file.path !== join(file.commerceTemporaryDirectory, "upload"))
    return new Uint8Array();
  const handle = await open(file.path, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read.bytesRead);
  } finally {
    await handle.close();
  }
}
