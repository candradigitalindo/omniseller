import { describe, expect, it } from "vitest";
import { type RequestContext, systemContext } from "../../common/context/request-context";
import { UnprocessableError } from "../../common/errors/domain-errors";
import { XLSX_MIME } from "../../common/xlsx";
import type { UsersService } from "../identity/users.service";
import { EmailAttachments } from "../notification/email-attachments";
import { ReportAttachments } from "./report-attachments";
import type { SalesReportService } from "./sales-report.service";
import type { StaffReportService } from "./staff-report.service";

const TENANT = "01HZZZZZZZZZZZZZZZZZZZZZZT";
const principal = (permissions: string[], extra: Partial<{ status: string; storeScope: string[] | null }> = {}) => ({
  user: {
    id: "01U",
    name: "Rina",
    email: "rina@example.test",
    locale: "id" as const,
    status: extra.status ?? "active",
  },
  permissions,
  storeScope: extra.storeScope ?? null,
  warehouseScope: null,
});

function setUp(opts: {
  principal?: ReturnType<typeof principal> | undefined;
  sales?: (ctx: RequestContext) => Promise<{ fileName: string; bytes: Uint8Array }>;
  staff?: (ctx: RequestContext) => Promise<{ fileName: string; bytes: Uint8Array }>;
}) {
  const files = new EmailAttachments();
  const loads: string[] = [];
  const users = {
    loadPrincipal: async (_tenantId: string, userId: string) => {
      loads.push(userId);
      return opts.principal;
    },
  } as unknown as UsersService;
  const sales = {
    workbook: opts.sales ?? (async () => ({ fileName: "penjualan.xlsx", bytes: new Uint8Array([1]) })),
  } as unknown as SalesReportService;
  const staff = {
    workbook: opts.staff ?? (async () => ({ fileName: "kinerja-tim.xlsx", bytes: new Uint8Array([2]) })),
  } as unknown as StaffReportService;
  new ReportAttachments(files, users, sales, staff).onModuleInit();
  return { files, loads };
}
const ctx = systemContext(TENANT);
const note = (kind: string, data: Record<string, unknown> = { from: "2026-10-05", to: "2026-10-11" }) => ({
  kind,
  userId: "01U",
  data,
});

describe("ReportAttachments", () => {
  it("draws only the report kinds, for notifications that name a period and a person", async () => {
    const { files, loads } = setUp({ principal: principal(["report:read"]) });
    expect(await files.for(ctx, note("billing.reminder"))).toEqual([]);
    expect(await files.for(ctx, note("export.ready", { from: "2026-10-05", to: "2026-10-11" }))).toEqual([]);
    expect(await files.for(ctx, { ...note("report.sales_weekly"), userId: null })).toEqual([]);
    expect(await files.for(ctx, note("report.sales_weekly", { from: 1, to: "2026-10-11" }))).toEqual([]);
    // nothing above looked anyone up
    expect(loads).toEqual([]);
    expect(await files.for(ctx, note("report.sales_weekly"))).toEqual([
      { filename: "penjualan.xlsx", contentType: XLSX_MIME, content: new Uint8Array([1]) },
    ]);
    expect(loads).toEqual(["01U"]);
  });

  it("reads as the recipient: their permissions and scope, never the job's", async () => {
    let seen: RequestContext | undefined;
    const { files } = setUp({
      principal: principal(["report:read", "order:read"], { storeScope: ["01S"] }),
      sales: async (reader) => {
        seen = reader;
        return { fileName: "penjualan.xlsx", bytes: new Uint8Array([1]) };
      },
    });
    await files.for(ctx, note("report.sales_monthly"));
    expect(seen?.actor).toEqual({ type: "user", id: "01U" });
    expect([...(seen?.permissions ?? [])]).toEqual(["report:read", "order:read"]);
    expect(seen?.storeScope).toEqual(new Set(["01S"]));
    expect(seen?.tenantId).toBe(TENANT);
  });

  it("sends no file to someone who may no longer see the report, or whose plan lost it", async () => {
    const gone = setUp({ principal: principal(["order:read"]) });
    expect(await gone.files.for(ctx, note("report.sales_weekly"))).toEqual([]);
    const disabled = setUp({ principal: principal(["report:read"], { status: "disabled" }) });
    expect(await disabled.files.for(ctx, note("report.sales_weekly"))).toEqual([]);
    const missing = setUp({ principal: undefined });
    expect(await missing.files.for(ctx, note("report.sales_weekly"))).toEqual([]);
    const starter = setUp({
      principal: principal(["settings:user"]),
      staff: async () => {
        throw new UnprocessableError(
          "billing.feature_unavailable",
          "Laporan kinerja staf tidak termasuk paket Starter.",
        );
      },
    });
    expect(await starter.files.for(ctx, note("report.staff_weekly"))).toEqual([]);
    // anything else is a bug and fails the email job, which retries
    const broken = setUp({
      principal: principal(["settings:user"]),
      staff: async () => {
        throw new Error("boom");
      },
    });
    await expect(broken.files.for(ctx, note("report.staff_monthly"))).rejects.toThrow("boom");
  });

  it("draws at most two workbooks at a time in one process", async () => {
    let running = 0;
    let most = 0;
    const { files } = setUp({
      principal: principal(["report:read"]),
      sales: async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return { fileName: "penjualan.xlsx", bytes: new Uint8Array([1]) };
      },
    });
    const drawn = await Promise.all([1, 2, 3, 4, 5].map(() => files.for(ctx, note("report.sales_weekly"))));
    expect(drawn.every((d) => d.length === 1)).toBe(true);
    expect(most).toBe(2);
  });
});
