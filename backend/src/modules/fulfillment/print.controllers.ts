import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import { ApiFoundResponse, ApiOkResponse, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, DeviceRoute, Isolation, RequirePermission } from "../../common/http/decorators";
import { decodeCursor, encodeCursor } from "../../common/http/pagination";
import {
  AgentJobListDto,
  AgentJobResultDto,
  AgentResultDto,
  AgentSelfDto,
  AgentStatusDto,
  AgentTakeQueryDto,
  CreatePrintAgentDto,
  PairedPrintAgentDto,
  PrintAgentDto,
  PrintAgentIdParamDto,
  PrintAgentListDto,
  PrintDocumentDto,
  PrintJobDto,
  PrintJobIdParamDto,
  PrintJobPageDto,
  PrintJobQueryDto,
  printAgentView,
  printJobView,
  TestPrintDto,
  UpdatePrintAgentDto,
} from "./print.dto";
import { agentJobView, PrintService } from "./print.service";
import { PrintAgentsService } from "./print-agents.service";
import { ScanPrintDto, ScanPrintResultDto, scannedOrderView } from "./scan.dto";
import { ScanService } from "./scan.service";

/** UI L42 and L07: the business's print agents (FR-SHP-17, backend doc 8.24). */
@ApiTags("print")
@Controller("v1/print-agents")
export class PrintAgentsController {
  constructor(@Inject(PrintAgentsService) private readonly agents: PrintAgentsService) {}

  /** Agents of the caller's warehouses, with the printers each reported and whether it is connected. */
  @Get()
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "print_agent" })
  @ZodResponse({ type: PrintAgentListDto })
  async list(@Ctx() ctx: RequestContext) {
    const now = Date.now();
    return { items: (await this.agents.list(ctx)).map((d) => printAgentView(d, now)) };
  }

  /** Pairs a computer. The token is shown once: paste it into the agent app. */
  @Post()
  @RequirePermission("settings:warehouse")
  @Isolation({ fixture: "warehouse" })
  @ZodResponse({ status: 201, type: PairedPrintAgentDto })
  async create(@Ctx() ctx: RequestContext, @Body() body: CreatePrintAgentDto) {
    const paired = await this.agents.create(ctx, body);
    return { agent: printAgentView(paired.device), token: paired.token };
  }

  @Get(":id")
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "print_agent" })
  @ZodResponse({ type: PrintAgentDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: PrintAgentIdParamDto) {
    return printAgentView(await this.agents.get(ctx, p.id));
  }

  @Patch(":id")
  @RequirePermission("settings:warehouse")
  @Isolation({ fixture: "print_agent" })
  @ZodResponse({ type: PrintAgentDto })
  async update(@Ctx() ctx: RequestContext, @Param() p: PrintAgentIdParamDto, @Body() body: UpdatePrintAgentDto) {
    return printAgentView(await this.agents.update(ctx, p.id, body));
  }

  /** Revokes the agent: its token stops working, its unprinted jobs are cancelled. */
  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("settings:warehouse")
  @Isolation({ fixture: "print_agent" })
  async revoke(@Ctx() ctx: RequestContext, @Param() p: PrintAgentIdParamDto): Promise<void> {
    await this.agents.revoke(ctx, p.id);
  }

  /** "Cetak percobaan": a 100 x 150 mm test page with a barcode to scan. */
  @Post(":id/test-print")
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "print_agent" })
  @ZodResponse({ status: 201, type: PrintJobDto })
  async testPrint(@Ctx() ctx: RequestContext, @Param() p: PrintAgentIdParamDto, @Body() body: TestPrintDto) {
    return printJobView(await this.agents.testPrint(ctx, p.id, body.printer));
  }
}

/** UI L07 "Antrean cetak", and scan to print (FR-SHP-17). */
@ApiTags("print")
@Controller("v1/print-jobs")
export class PrintJobsController {
  constructor(
    @Inject(PrintService) private readonly print: PrintService,
    @Inject(ScanService) private readonly scan: ScanService,
  ) {}

  /** Newest first. Users limited to some stores or warehouses see their own requests. */
  @Get()
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "print_job" })
  @ZodResponse({ type: PrintJobPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: PrintJobQueryDto) {
    const page = await this.print.list(
      ctx,
      { deviceId: q.deviceId, status: q.status },
      decodeCursor(q.cursor),
      q.limit,
    );
    const last = page.items[page.items.length - 1];
    return { items: page.items.map(printJobView), next_cursor: page.more && last ? encodeCursor(last.id) : null };
  }

  /** Prints a document (again) on an agent; it waits for the worker when the document is still being made. */
  @Post()
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "document" })
  @ZodResponse({ status: 201, type: PrintJobDto })
  async create(@Ctx() ctx: RequestContext, @Body() body: PrintDocumentDto) {
    return printJobView(await this.print.printDocument(ctx, body.documentId, body));
  }

  /**
   * "Scan untuk cetak": the order behind a scanned order number or tracking number gets its label printed
   * on the agent, without a print dialog. 409 with the reason when the label cannot be printed yet.
   */
  @Post("scan")
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "order" })
  @ZodResponse({ status: 201, type: ScanPrintResultDto })
  async scanToPrint(@Ctx() ctx: RequestContext, @Body() body: ScanPrintDto) {
    const done = await this.scan.scanToPrint(ctx, body.code, body, body);
    return { order: scannedOrderView(done.order), documentId: done.documentId, printJob: printJobView(done.printJob) };
  }

  @Get(":id")
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "print_job" })
  @ZodResponse({ type: PrintJobDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: PrintJobIdParamDto) {
    return printJobView(await this.print.get(ctx, p.id));
  }

  /** "Cetak ulang": a failed job, or one the agent took and never reported, goes back to the agent. */
  @Post(":id/retry")
  @HttpCode(200)
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "print_job" })
  @ZodResponse({ type: PrintJobDto })
  async retry(@Ctx() ctx: RequestContext, @Param() p: PrintJobIdParamDto) {
    return printJobView(await this.print.retry(ctx, p.id));
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "print_job" })
  @ZodResponse({ type: PrintJobDto })
  async cancel(@Ctx() ctx: RequestContext, @Param() p: PrintJobIdParamDto) {
    return printJobView(await this.print.cancel(ctx, p.id));
  }
}

/**
 * The print agent's own routes, signed in with its device token (`Authorization: Bearer`). The agent
 * also connects to Socket.IO (`/socket.io`, `auth.token`) to hear `print.job` and `print.cancelled`.
 */
@ApiTags("agent")
@Controller("v1/agent")
@DeviceRoute("print_agent")
export class AgentController {
  constructor(
    @Inject(PrintService) private readonly print: PrintService,
    @Inject(PrintAgentsService) private readonly agents: PrintAgentsService,
  ) {}

  /** A test page on the calling device only; the device cannot select another agent. */
  @Post("test-print")
  @Isolation("self")
  @ZodResponse({ status: 201, type: AgentJobResultDto })
  async testPrint(@Ctx() ctx: RequestContext, @Body() body: TestPrintDto) {
    const j = await this.agents.testPrint(ctx, ctx.actor.id, body.printer);
    return { id: j.id, status: j.status };
  }

  /** On start, every minute, and when printers change: the version and the printers it sees. */
  @Put("status")
  @Isolation("self")
  @ZodResponse({ type: AgentSelfDto })
  async status(@Ctx() ctx: RequestContext, @Body() body: AgentStatusDto) {
    const d = await this.print.agentStatus(ctx, body);
    return { id: d.id, name: d.name, labelPrinter: d.labelPrinter, documentPrinter: d.documentPrinter };
  }

  /** What is still to print, oldest first: after (re)connecting, and as a safety net every minute. */
  @Get("print-jobs")
  @Isolation({ fixture: "print_job", actor: "device" })
  @ZodResponse({ type: AgentJobListDto })
  async pending(@Ctx() ctx: RequestContext) {
    return { items: (await this.print.pending(ctx)).map(agentJobView) };
  }

  /** An explicit local retry of the calling device's failed or unreported job. */
  @Post("print-jobs/:id/retry")
  @HttpCode(200)
  @Isolation({ fixture: "print_job", actor: "device" })
  @ZodResponse({ type: AgentJobResultDto })
  async retry(@Ctx() ctx: RequestContext, @Param() p: PrintJobIdParamDto) {
    const j = await this.print.retry(ctx, p.id);
    return { id: j.id, status: j.status };
  }

  /**
   * The job's PDF: a redirect to a signed link valid 10 minutes (R2), or the file (local storage).
   * Taking it marks the job `sent`; 409 when the job was cancelled or already reported.
   */
  @Get("print-jobs/:id/file")
  @Isolation({ fixture: "print_job", actor: "device" })
  @ApiProduces("application/pdf")
  @ApiOkResponse({ description: "The file (local storage)." })
  @ApiFoundResponse({ description: "Redirect to a signed link valid for 10 minutes (R2)." })
  async file(
    @Ctx() ctx: RequestContext,
    @Param() p: PrintJobIdParamDto,
    @Query() q: AgentTakeQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.print.take(ctx, p.id, q.attempt);
    res.setHeader("cache-control", "private, no-store");
    if ("url" in target) {
      res.redirect(302, target.url);
      return;
    }
    res.setHeader("content-type", target.mime);
    res.setHeader("content-disposition", `${target.disposition}; filename="${target.filename}"`);
    res.send(Buffer.from(target.bytes));
  }

  /** Printed, or failed with the printer's message. Reporting the same result twice changes nothing. */
  @Post("print-jobs/:id/result")
  @HttpCode(200)
  @Isolation({ fixture: "print_job", actor: "device" })
  @ZodResponse({ type: AgentJobResultDto })
  async result(@Ctx() ctx: RequestContext, @Param() p: PrintJobIdParamDto, @Body() body: AgentResultDto) {
    const j = await this.print.report(ctx, p.id, body);
    return { id: j.id, status: j.status };
  }
}
