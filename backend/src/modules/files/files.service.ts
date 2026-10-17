import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Inject, Injectable } from "@nestjs/common";
import { assertUlid, newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { InternalError, ValidationError } from "../../common/errors/domain-errors";
import type { DbHandle, Tx } from "../../db/client";
import type { FilePurpose } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { FILE_STORAGE, type FileStorage, fileRangeSize, MAX_STREAM_FILE_BYTES } from "./file-storage";
import { fileNotFound } from "./files.errors";
import { type FileRow, FilesRepository } from "./files.repository";

/** Signed download links live this long (the print agent gets the same, technology doc 12). */
export const DOWNLOAD_TTL_SECONDS = 600;

export interface SaveFileInput {
  purpose: FilePurpose;
  mime: string;
  /** File name extension without the dot. */
  ext: string;
  bytes: Uint8Array;
  /** Files with buyer data expire; the cleanup job deletes the object and the row. */
  expiresAt: Date | null;
  createdBy?: string | null;
}

export type SaveStreamInput = Omit<SaveFileInput, "bytes"> & { stream: Readable; sizeBytes: number };
export type SaveLocalFileInput = Omit<SaveFileInput, "bytes"> & { path: string; sizeBytes?: number };

const invalidStream = () =>
  new ValidationError([
    { path: "file", message: "Berkas harus berukuran 1 byte hingga 500 MiB dengan ukuran yang sesuai." },
  ]);

export type DownloadTarget =
  | { url: string }
  | { bytes: Uint8Array; mime: string; filename: string; disposition: "inline" | "attachment" };

export interface DownloadOptions {
  /** Name the browser saves the file as; `<purpose>-<id>.<ext>` otherwise. */
  filename?: string;
  disposition?: "inline" | "attachment";
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Private files (backend doc 8.15, module `files`): bytes in R2 (MinIO or a directory locally), one
 * `file_object` row each. The upload happens before the row is written, never inside a transaction.
 */
@Injectable()
export class FilesService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(FilesRepository) private readonly repo: FilesRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async save(ctx: RequestContext, input: SaveFileInput): Promise<FileRow> {
    const id = newId();
    const key = `t/${ctx.tenantId}/${input.purpose}/${id}.${input.ext}`;
    await this.storage.put(key, input.bytes, input.mime);
    return withTenantTx(this.db, ctx, (tx) =>
      this.repo.insert(tx, {
        id,
        tenantId: ctx.tenantId,
        bucket: this.storage.bucket,
        objectKey: key,
        mime: input.mime,
        sizeBytes: input.bytes.length,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        createdBy: input.createdBy ?? null,
      }),
    );
  }

  /** Like `save`, for a file on disk that is streamed to storage (the full data export). */
  async saveFile(ctx: RequestContext, input: Omit<SaveFileInput, "bytes"> & { path: string }): Promise<FileRow> {
    const id = newId();
    const key = `t/${ctx.tenantId}/${input.purpose}/${id}.${input.ext}`;
    const [{ size }, sha256] = await Promise.all([stat(input.path), sha256File(input.path)]);
    await this.storage.putFile(key, input.path, input.mime);
    return withTenantTx(this.db, ctx, (tx) =>
      this.repo.insert(tx, {
        id,
        tenantId: ctx.tenantId,
        bucket: this.storage.bucket,
        objectKey: key,
        mime: input.mime,
        sizeBytes: size,
        sha256,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        createdBy: input.createdBy ?? null,
      }),
    );
  }

  /** Bounded user media: hashing and storage both stream, before opening the metadata transaction. */
  async saveStream(ctx: RequestContext, input: SaveStreamInput): Promise<FileRow> {
    try {
      assertUlid(ctx.tenantId);
    } catch (error) {
      input.stream.destroy();
      throw error;
    }
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 1 ||
      input.sizeBytes > MAX_STREAM_FILE_BYTES ||
      !/^[a-z0-9]{1,12}$/i.test(input.ext)
    ) {
      input.stream.destroy();
      throw invalidStream();
    }
    const id = newId();
    const key = `t/${ctx.tenantId}/${input.purpose}/${id}.${input.ext}`;
    const hash = createHash("sha256");
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    const piping = pipeline(input.stream, hashing);
    const upload = this.storage.putStream(key, hashing, input.mime, input.sizeBytes);
    try {
      await Promise.all([piping, upload]);
    } catch (error) {
      input.stream.destroy();
      hashing.destroy();
      await Promise.allSettled([piping, upload]);
      await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
    // As with save/saveFile, an uncertain database commit must not delete an object that may already
    // have a committed row. Failed uploads above have not opened any database transaction.
    return withTenantTx(this.db, ctx, (tx) =>
      this.repo.insert(tx, {
        id,
        tenantId: ctx.tenantId,
        bucket: this.storage.bucket,
        objectKey: key,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        sha256: hash.digest("hex"),
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        createdBy: input.createdBy ?? null,
      }),
    );
  }

  /** An API-spooled file can be up to 500 MiB without being materialized as one byte array. */
  async saveFromLocalFile(ctx: RequestContext, input: SaveLocalFileInput): Promise<FileRow> {
    const file = await stat(input.path);
    if (
      !file.isFile() ||
      file.size < 1 ||
      file.size > MAX_STREAM_FILE_BYTES ||
      (input.sizeBytes !== undefined && input.sizeBytes !== file.size)
    )
      throw invalidStream();
    return this.saveStream(ctx, { ...input, stream: createReadStream(input.path), sizeBytes: file.size });
  }

  /** Contents of a file of this tenant, or null when it is gone. */
  async read(ctx: RequestContext, id: string): Promise<Uint8Array | null> {
    const row = await this.metadata(ctx, id);
    return row ? this.storage.get(row.objectKey) : null;
  }
  /** Tenant-owned, unexpired file metadata for owning modules before consuming private bytes. */
  async metadata(ctx: RequestContext, id: string) {
    const row = await withTenantTx(this.db, ctx, (tx) => this.repo.get(tx, id));
    return row && (!row.expiresAt || row.expiresAt > new Date()) ? row : null;
  }

  /** Half-open [start,endExclusive), at most 30 MiB, for a tenant-owned unexpired upload. */
  async readRange(ctx: RequestContext, id: string, start: number, endExclusive: number): Promise<Uint8Array> {
    let size: number;
    try {
      size = fileRangeSize(start, endExclusive);
    } catch {
      throw new ValidationError([{ path: "range", message: "Rentang berkas tidak valid atau melebihi 30 MiB." }]);
    }
    const row = await this.metadata(ctx, id);
    if (!row || row.tenantId !== ctx.tenantId || !row.objectKey.startsWith(`t/${ctx.tenantId}/`)) throw fileNotFound();
    if (endExclusive > row.sizeBytes)
      throw new ValidationError([{ path: "range", message: "Rentang berkas melebihi ukuran unggahan." }]);
    const bytes = await this.storage.getRange(row.objectKey, start, endExclusive);
    if (bytes.length !== size)
      throw new InternalError("file.range_incomplete", "Bagian berkas tidak dapat dibaca secara lengkap.");
    const latest = await this.metadata(ctx, id);
    if (
      !latest ||
      latest.tenantId !== ctx.tenantId ||
      latest.objectKey !== row.objectKey ||
      latest.sizeBytes !== row.sizeBytes ||
      latest.sha256 !== row.sha256
    )
      throw fileNotFound();
    return bytes;
  }

  /** A signed link (R2), or the bytes for the api to send (local storage). Other purposes are not found. */
  async download(
    ctx: RequestContext,
    id: string,
    purposes: readonly FilePurpose[],
    opts: DownloadOptions = {},
  ): Promise<DownloadTarget> {
    const row = await withTenantTx(this.db, ctx, (tx) => this.repo.get(tx, id));
    if (!row || !purposes.includes(row.purpose) || (row.expiresAt && row.expiresAt <= new Date())) {
      throw fileNotFound();
    }
    const ext = row.objectKey.slice(row.objectKey.lastIndexOf(".") + 1);
    const filename = opts.filename ?? `${row.purpose.replace("_", "-")}-${row.id.toLowerCase()}.${ext}`;
    const disposition = opts.disposition ?? "inline";
    const url = await this.storage.signedUrl(row.objectKey, {
      filename,
      mime: row.mime,
      ttlSeconds: DOWNLOAD_TTL_SECONDS,
      disposition,
    });
    if (url) return { url };
    return { bytes: await this.storage.get(row.objectKey), mime: row.mime, filename, disposition };
  }

  /**
   * These files expire now, in the caller's transaction: the hourly cleanup deletes object and row. For
   * files whose data must go (a store's data deleted, FR-INT-07) without an upload or delete inside the
   * transaction.
   */
  async expireIn(tx: Tx, ids: string[], now = new Date()): Promise<void> {
    await this.repo.expire(tx, [...new Set(ids)], now);
  }

  /**
   * Every stored object of a closed business (`t/<tenantId>/`, backend doc 8.36): its purge deletes the rows
   * itself. Returns how many went.
   */
  deleteAllObjects(tenantId: string): Promise<number> {
    return this.storage.deletePrefix(`t/${tenantId}/`);
  }

  /** Deletes this tenant's expired files: the object, then the row (rows pointing at it lose the link). */
  async cleanupExpired(ctx: RequestContext, now = new Date(), limit = 500): Promise<number> {
    const rows = await withTenantTx(this.db, ctx, (tx) => this.repo.expired(tx, now, limit));
    for (const r of rows) await this.storage.delete(r.objectKey);
    if (rows.length > 0) {
      await withTenantTx(this.db, ctx, (tx) =>
        this.repo.delete(
          tx,
          rows.map((r) => r.id),
        ),
      );
    }
    return rows.length;
  }
}
