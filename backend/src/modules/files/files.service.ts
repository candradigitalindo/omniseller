import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import type { FilePurpose } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { FILE_STORAGE, type FileStorage } from "./file-storage";
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

  /** Contents of a file of this tenant, or null when it is gone. */
  async read(ctx: RequestContext, id: string): Promise<Uint8Array | null> {
    const row = await withTenantTx(this.db, ctx, (tx) => this.repo.get(tx, id));
    return row ? this.storage.get(row.objectKey) : null;
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
