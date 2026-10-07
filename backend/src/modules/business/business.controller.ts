import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req, Res } from "@nestjs/common";
import { ApiFoundResponse, ApiOkResponse, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { parseIfMatch } from "../../common/http/if-match";
import type { AuthedRequest } from "../../common/http/request";
import { sendDownload } from "../../common/http/send-download";
import { BusinessProfileService } from "./business-profile.service";
import {
  AddBusinessDocumentDto,
  BusinessDocumentDto,
  BusinessDocumentIdParamDto,
  BusinessProfileDto,
  documentDto,
  profileDto,
  SetLogoDto,
  UpdateBusinessDocumentDto,
  UpdateBusinessProfileDto,
} from "./dto";

/**
 * Profil Bisnis & Legalitas (UI L47, backend doc 8.29): who the business is and its legal papers. The
 * Owner's (settings:billing): the NIB and NPWP are the business's to declare.
 */
@ApiTags("business")
@Controller("v1/business-profile")
@RequirePermission("settings:billing")
export class BusinessProfileController {
  constructor(@Inject(BusinessProfileService) private readonly profiles: BusinessProfileService) {}

  @Get()
  @Isolation("self")
  @ZodResponse({ type: BusinessProfileDto })
  async get(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    const p = await this.profiles.get(ctx);
    res.setHeader("ETag", `"${p.rowVersion}"`);
    return profileDto(p);
  }

  /** With If-Match: the `rowVersion` read ("0" before the first save). */
  @Patch()
  @Isolation("self")
  @ZodResponse({ type: BusinessProfileDto })
  async update(
    @Ctx() ctx: RequestContext,
    @Body() body: UpdateBusinessProfileDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const p = await this.profiles.update(ctx, body, parseIfMatch(req));
    res.setHeader("ETag", `"${p.rowVersion}"`);
    return profileDto(p);
  }

  @Get("logo")
  @Isolation("self")
  @ApiProduces("image/png", "image/jpeg", "image/webp")
  @ApiOkResponse({ description: "The logo (local storage)." })
  @ApiFoundResponse({ description: "Redirect to a signed link valid for 10 minutes (R2)." })
  async logo(@Ctx() ctx: RequestContext, @Res() res: Response): Promise<void> {
    sendDownload(res, await this.profiles.logo(ctx));
  }

  @Put("logo")
  @Isolation("self")
  @ZodResponse({ type: BusinessProfileDto })
  async setLogo(@Ctx() ctx: RequestContext, @Body() body: SetLogoDto) {
    return profileDto(await this.profiles.setLogo(ctx, body.content));
  }

  @Delete("logo")
  @Isolation("self")
  @ZodResponse({ type: BusinessProfileDto })
  async removeLogo(@Ctx() ctx: RequestContext) {
    return profileDto(await this.profiles.removeLogo(ctx));
  }
}

@ApiTags("business")
@Controller("v1/business-documents")
@RequirePermission("settings:billing")
export class BusinessDocumentsController {
  constructor(@Inject(BusinessProfileService) private readonly profiles: BusinessProfileService) {}

  @Post()
  @Isolation("self")
  @ZodResponse({ status: 201, type: BusinessDocumentDto })
  async add(@Ctx() ctx: RequestContext, @Body() body: AddBusinessDocumentDto) {
    return documentDto(await this.profiles.addDocument(ctx, body));
  }

  @Patch(":id")
  @Isolation({ fixture: "business_document" })
  @ZodResponse({ type: BusinessDocumentDto })
  async update(
    @Ctx() ctx: RequestContext,
    @Param() p: BusinessDocumentIdParamDto,
    @Body() body: UpdateBusinessDocumentDto,
  ) {
    return documentDto(await this.profiles.updateDocument(ctx, p.id, body));
  }

  @Delete(":id")
  @HttpCode(204)
  @Isolation({ fixture: "business_document" })
  async remove(@Ctx() ctx: RequestContext, @Param() p: BusinessDocumentIdParamDto): Promise<void> {
    await this.profiles.removeDocument(ctx, p.id);
  }

  @Get(":id/file")
  @Isolation({ fixture: "business_document" })
  @ApiProduces("application/pdf", "image/png", "image/jpeg")
  @ApiOkResponse({ description: "The document (local storage)." })
  @ApiFoundResponse({ description: "Redirect to a signed link valid for 10 minutes (R2)." })
  async file(@Ctx() ctx: RequestContext, @Param() p: BusinessDocumentIdParamDto, @Res() res: Response): Promise<void> {
    sendDownload(res, await this.profiles.documentFile(ctx, p.id));
  }
}
