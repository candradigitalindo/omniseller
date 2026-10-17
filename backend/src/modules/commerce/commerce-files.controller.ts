import { Body, Controller, Get, Inject, Param, Post, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { NotFoundError } from "../../common/errors/domain-errors";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { sendDownload } from "../../common/http/send-download";
import { CommerceParamDto } from "./commerce.dto";
import { CommerceService } from "./commerce.service";
import { CommerceFileDto, UploadCommerceFileDto } from "./commerce-files.dto";
import { CommerceFilesService, type CommerceUpload } from "./commerce-files.service";
import { CommerceUploadCleanupInterceptor, commerceUploadStorage } from "./commerce-upload";
@ApiTags("commerce")
@Controller("v1/commerce")
export class CommerceFilesController {
  constructor(
    @Inject(CommerceService) private readonly commerce: CommerceService,
    @Inject(CommerceFilesService) private readonly files: CommerceFilesService,
  ) {}
  @Post("files")
  @ApiOperation({ summary: "Unggah berkas privat untuk satu akun dan fitur commerce" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["operationId", "principalId", "file"],
      properties: {
        operationId: { type: "string" },
        principalId: { type: "string" },
        fieldName: {
          type: "string",
          description: "Field berkas tujuan; wajib untuk fitur yang menerima beberapa berkas.",
        },
        file: { type: "string", format: "binary" },
      },
    },
  })
  @RequirePermission("commerce:write")
  @Isolation({ fixture: "commerce_operation" })
  @ZodResponse({ type: CommerceFileDto })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: commerceUploadStorage,
      limits: { fileSize: 500 * 1024 * 1024, files: 1, fields: 3 },
    }),
    CommerceUploadCleanupInterceptor,
  )
  async upload(
    @Ctx() ctx: RequestContext,
    @Body() body: UploadCommerceFileDto,
    @UploadedFile() file: CommerceUpload | undefined,
  ) {
    const operation = this.commerce.operation(body.operationId);
    await this.commerce.assert(ctx, operation, body.principalId);
    return this.files.save(
      ctx,
      operation,
      body.principalId,
      file,
      () => this.commerce.assertFresh(ctx, operation, body.principalId),
      body.fieldName,
    );
  }
  @Get("requests/:id/download")
  @ApiOperation({ summary: "Unduh berkas hasil commerce selama masa simpan privat" })
  @ApiProduces("application/octet-stream")
  @ApiOkResponse({ description: "Berkas privat." })
  @ApiFoundResponse({ description: "Tautan unduh privat sementara." })
  @RequirePermission("commerce:read")
  @Isolation({ fixture: "commerce_operation" })
  async download(@Ctx() ctx: RequestContext, @Param() param: CommerceParamDto, @Res() res: Response) {
    const request = await this.commerce.get(ctx, param.id);
    if (!request.result?.artifact)
      throw new NotFoundError("commerce.file_not_found", "Berkas hasil tidak ditemukan atau sudah kedaluwarsa.");
    sendDownload(res, await this.files.download(ctx, request.result.artifact.fileId));
  }
}
