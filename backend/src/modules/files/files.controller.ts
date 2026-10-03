import { Controller, Get, Inject, Param, Res } from "@nestjs/common";
import { ApiFoundResponse, ApiOkResponse, ApiProduces, ApiTags } from "@nestjs/swagger";
import { ulidSchema } from "@omniseller/shared";
import type { Response } from "express";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { FilesService } from "./files.service";

export class FileIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

@ApiTags("files")
@Controller("v1/files")
export class FilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  /**
   * Shipping labels and printable documents (FR-SHP-01, 02). With R2 the answer is a redirect to a
   * signed link valid for 10 minutes; with local storage the file itself.
   */
  @Get(":id/download")
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "file_object" })
  @ApiProduces("application/pdf")
  @ApiOkResponse({ description: "The file (local storage)." })
  @ApiFoundResponse({ description: "Redirect to a signed link valid for 10 minutes (R2)." })
  async download(@Ctx() ctx: RequestContext, @Param() p: FileIdParamDto, @Res() res: Response): Promise<void> {
    const target = await this.files.download(ctx, p.id, ["label", "pick_list"]);
    res.setHeader("cache-control", "private, no-store");
    if ("url" in target) {
      res.redirect(302, target.url);
      return;
    }
    res.setHeader("content-type", target.mime);
    res.setHeader("content-disposition", `${target.disposition}; filename="${target.filename}"`);
    res.send(Buffer.from(target.bytes));
  }
}
