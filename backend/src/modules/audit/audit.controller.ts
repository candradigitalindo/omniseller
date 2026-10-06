import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ulidSchema } from "@omniseller/shared";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { pageSchema, paginationQuery } from "../../common/http/pagination";
import { AuditLogService } from "./audit-log.service";

const actorType = z.enum(["user", "system", "api_key", "device"]);

const auditEntry = z.object({
  id: ulidSchema,
  at: z.iso.datetime(),
  actorType,
  actorId: z.string().nullable(),
  requestId: z.string().nullable().describe("entri dengan requestId yang sama berasal dari satu tindakan"),
  action: z.enum(["insert", "update", "delete"]),
  entityType: z.string(),
  entityId: ulidSchema,
  before: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe("baris sebelum diubah (nama kolom basis data); HPP tidak ada tanpa izin finance:read"),
  after: z.record(z.string(), z.unknown()).nullable(),
  actor: z.object({
    type: actorType,
    id: z.string().nullable(),
    name: z.string().nullable().describe("nama pengguna atau agen cetak; null untuk sistem"),
  }),
  change: z
    .enum(["created", "updated", "deleted", "restored"])
    .describe("deleted dan restored juga untuk data yang diarsipkan lalu dipulihkan"),
  label: z
    .string()
    .nullable()
    .describe("yang diubah: SKU varian, nama produk atau toko, nomor pesanan atau dokumen, nama pengguna"),
  changes: z
    .array(
      z.object({
        field: z.string().describe("nama field di API, misalnya basePrice; rujukan tanpa Id, misalnya warehouse"),
        before: z.unknown().describe("rujukan (warehouse, role, variant, order) berupa namanya"),
        after: z.unknown(),
        hidden: z.literal(true).optional().describe("nilainya disembunyikan (HPP tanpa izin finance:read)"),
      }),
    )
    .describe("field yang dikenali penjual: yang berubah, atau isinya saat dibuat atau dihapus"),
});

class AuditPageDto extends createZodDto(pageSchema(auditEntry)) {}
class AuditPeopleDto extends createZodDto(
  z.object({ items: z.array(z.object({ id: ulidSchema, name: z.string() })) }),
) {}
class AuditQueryDto extends createZodDto(
  paginationQuery.extend({
    entity_type: z
      .string()
      .max(400)
      .regex(/^[a-z_]+(,[a-z_]+){0,19}$/)
      .optional()
      .describe("satu jenis atau beberapa dipisah koma, misalnya product,variant"),
    entity_id: ulidSchema.optional(),
    actor_id: ulidSchema.optional().describe("pengguna atau agen cetak yang bertindak"),
    from: z.iso.datetime({ offset: true }).optional().describe("sejak waktu ini"),
    to: z.iso.datetime({ offset: true }).optional().describe("sebelum waktu ini"),
  }),
) {}

@ApiTags("audit")
@Controller("v1/audit-logs")
@RequirePermission("audit:read")
export class AuditController {
  constructor(@Inject(AuditLogService) private readonly log: AuditLogService) {}

  /**
   * FR-USR-04: who changed what and when, newest first (backend doc 8.28). Entries that changed nothing a
   * seller would recognise are left out, so a page may hold fewer than `limit`; follow `next_cursor`.
   */
  @Get()
  @Isolation({ fixture: "audit" })
  @ZodResponse({ type: AuditPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: AuditQueryDto) {
    const p = await this.log.list(
      ctx,
      {
        entityTypes: q.entity_type?.split(","),
        entityId: q.entity_id,
        actorId: q.actor_id,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
      },
      q.cursor,
      q.limit,
    );
    return {
      items: p.items.map((e) => ({
        id: e.id,
        at: e.createdAt.toISOString(),
        actorType: e.actorType,
        actorId: e.actorId,
        requestId: e.requestId,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        before: e.before,
        after: e.after,
        actor: e.actor,
        change: e.change,
        label: e.label,
        changes: e.changes,
      })),
      next_cursor: p.next_cursor,
    };
  }

  /** The people of the business, disabled ones too: who the log can be narrowed to. */
  @Get("people")
  @Isolation({ fixture: "user" })
  @ZodResponse({ type: AuditPeopleDto })
  async people(@Ctx() ctx: RequestContext) {
    return { items: await this.log.people(ctx) };
  }
}
