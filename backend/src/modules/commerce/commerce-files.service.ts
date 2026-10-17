import { Inject, Injectable } from "@nestjs/common";
import type {
  CommerceCredentials,
  CommerceExecutionResult,
  CommerceInput,
  CommerceOperation,
} from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import { NotFoundError, ValidationError } from "../../common/errors/domain-errors";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { FilesService } from "../files/files.service";
import { CommerceFilesRepository } from "./commerce-files.repository";
import { commerceMediaType } from "./commerce-media";
import { commerceUploadPrefix } from "./commerce-upload";

const missing = () =>
  new NotFoundError(
    "commerce.file_not_found",
    "Berkas tidak ditemukan, sudah kedaluwarsa, atau berasal dari akun/operasi lain.",
  );
const invalid = (message: string) => new ValidationError([{ path: "file", message }]);
export interface CommerceUpload {
  buffer?: Uint8Array;
  path?: string;
  commerceTemporaryDirectory?: string;
  size: number;
}
@Injectable()
export class CommerceFilesService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(CommerceFilesRepository) private readonly repo: CommerceFilesRepository,
  ) {}
  async save(
    ctx: RequestContext,
    operation: CommerceOperation,
    principalId: string,
    upload: CommerceUpload | undefined,
    beforeCommit: () => Promise<unknown>,
    fieldName?: string,
  ) {
    const fields = operation.fields.filter((item) => item.type === "file");
    const field = fieldName
      ? fields.find((item) => item.name === fieldName)
      : fields.length === 1
        ? fields[0]
        : undefined;
    if (!field || !upload || upload.size <= 0) throw invalid("Pilih berkas yang sesuai fitur marketplace.");
    const type = commerceMediaType(await commerceUploadPrefix(upload));
    const limit = (type ? field.maxBytesByMime?.[type.mime] : undefined) ?? field.maxBytes ?? 10_000_000;
    if (!type || !field.accept?.includes(type.mime) || upload.size > limit || upload.size < (field.minBytes ?? 1))
      throw invalid("Jenis atau ukuran berkas tidak sesuai persyaratan fitur marketplace.");
    const expiresAt = new Date(Date.now() + 3_600_000);
    const filename = `commerce.${type.ext}`;
    const metadata = {
      purpose: "other",
      mime: type.mime,
      ext: type.ext,
      expiresAt,
      createdBy: ctx.actor.type === "user" ? ctx.actor.id : null,
    } as const;
    const file = upload.path
      ? await this.files.saveFromLocalFile(ctx, { ...metadata, path: upload.path, sizeBytes: upload.size })
      : await this.files.save(ctx, { ...metadata, bytes: upload.buffer ?? new Uint8Array() });
    const id = newId();
    await withTenantTx(this.db, ctx, async (tx) => {
      const active = await tx.execute(
        sql`SELECT id FROM tenant WHERE id=${ctx.tenantId} AND status='active' FOR SHARE`,
      );
      if (!active.rows.length) throw missing();
      await beforeCommit();
      await this.repo.insert(tx, {
        id,
        tenantId: ctx.tenantId,
        operationId: operation.id,
        fieldName: field.name,
        principalKind: operation.principalKind,
        storeId: operation.principalKind === "seller" ? principalId : null,
        accountId: operation.principalKind !== "seller" ? principalId : null,
        fileId: file.id,
        createdBy: ctx.actor.type === "user" ? ctx.actor.id : null,
        filename,
        mime: type.mime,
        sizeBytes: file.sizeBytes,
        expiresAt,
      });
    });
    return {
      fileId: id,
      filename,
      mime: type.mime,
      sizeBytes: file.sizeBytes,
      expiresAt: expiresAt.toISOString(),
    };
  }
  async inputFiles(
    ctx: RequestContext,
    operation: CommerceOperation,
    principalId: string,
    input: CommerceInput,
    includeBytes: boolean,
  ): Promise<NonNullable<CommerceCredentials["files"]>> {
    const loaded: NonNullable<CommerceCredentials["files"]> = {};
    for (const field of operation.fields.filter((item) => item.type === "file")) {
      const [section, key] = field.name.split(".");
      const id = input[section as "body" | "query" | "path"]?.[key!];
      if (id === undefined && !field.required) continue;
      if (typeof id !== "string") throw missing();
      const row = await withTenantTx(this.db, ctx, (tx) => this.repo.get(tx, id));
      if (
        !row?.fileId ||
        row.operationId !== operation.id ||
        (row.fieldName !== null && row.fieldName !== field.name) ||
        (operation.fields.filter((item) => item.type === "file").length > 1 && row.fieldName === null) ||
        (row.storeId ?? row.accountId) !== principalId ||
        row.principalKind !== operation.principalKind ||
        row.expiresAt.getTime() <= Date.now()
      )
        throw missing();
      const limit = field.maxBytesByMime?.[row.mime] ?? field.maxBytes ?? 10_000_000;
      if (!field.accept?.includes(row.mime) || row.sizeBytes > limit || row.sizeBytes < (field.minBytes ?? 1))
        throw missing();
      const stored = await this.files.metadata(ctx, row.fileId);
      if (stored?.purpose !== "other" || stored.mime !== row.mime || stored.sizeBytes !== row.sizeBytes)
        throw missing();
      if (includeBytes) {
        if (operation.transport === "large_upload") {
          loaded[id] = {
            bytes: new Uint8Array(),
            mime: row.mime,
            filename: row.filename,
            size: row.sizeBytes,
            readRange: (start, end) => this.files.readRange(ctx, row.fileId!, start, end),
          };
          continue;
        }
        const bytes = await this.files.read(ctx, row.fileId);
        if (!bytes || bytes.length !== row.sizeBytes) throw missing();
        loaded[id] = { bytes, mime: row.mime, filename: row.filename };
      }
    }
    return loaded;
  }
  async retainDownload(ctx: RequestContext, download: NonNullable<CommerceExecutionResult["download"]>) {
    if (!download.bytes.length || download.bytes.length > 20_000_000)
      throw invalid("Berkas hasil marketplace melampaui batas 20 MB.");
    const expiresAt = new Date(Date.now() + 3_600_000);
    const file = await this.files.save(ctx, {
      purpose: "other",
      mime: download.mime,
      ext: download.ext,
      bytes: download.bytes,
      expiresAt,
      createdBy: ctx.actor.type === "user" ? ctx.actor.id : null,
    });
    return {
      fileId: file.id,
      mime: download.mime,
      sizeBytes: download.bytes.length,
      expiresAt: expiresAt.toISOString(),
    };
  }
  download(ctx: RequestContext, fileId: string) {
    return this.files.download(ctx, fileId, ["other"], { disposition: "attachment" });
  }
  exportSheets(): ExportSheet[] {
    return [
      {
        file: "berkas_commerce.csv",
        description:
          "Metadata unggahan commerce sementara yang terikat akun dan fitur; isi berkas disimpan privat hingga satu jam.",
        columns: [
          "id",
          "operasi",
          "field_berkas",
          "jenis_akun",
          "id_toko",
          "id_akun",
          "mime",
          "ukuran_byte",
          "dibuat_pada",
          "kedaluwarsa_pada",
        ],
        pages: (tx) =>
          keysetPages(
            (after) => this.repo.page(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((row) => [
                row.id,
                row.operationId,
                row.fieldName,
                row.principalKind,
                row.storeId,
                row.accountId,
                row.mime,
                row.sizeBytes,
                row.createdAt,
                row.expiresAt,
              ]),
          ),
      },
    ];
  }
}
