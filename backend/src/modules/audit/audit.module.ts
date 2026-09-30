import { Controller, Get, Inject, Injectable, Module, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ulidSchema } from "@omniseller/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { decodeCursor, page, pageSchema, paginationQuery } from "../../common/http/pagination";
import type { DbHandle } from "../../db/client";
import { auditLog } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";

/**
 * Audit log reading (PRD FR-USR-04). Rows are written only by the audit_row() trigger
 * (backend doc 7.7); this module never writes.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DB_TENANT) private readonly db: DbHandle) {}

  async list(
    ctx: RequestContext,
    filter: { entityType?: string | undefined; entityId?: string | undefined },
    cursor: string | undefined,
    limit: number,
  ) {
    const before = decodeCursor(cursor);
    const rows = await withTenantTx(this.db, ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            filter.entityType ? eq(auditLog.entityType, filter.entityType) : undefined,
            filter.entityId ? eq(auditLog.entityId, filter.entityId) : undefined,
            before ? lt(auditLog.id, before) : undefined,
          ),
        )
        .orderBy(desc(auditLog.id))
        .limit(limit + 1),
    );
    return page(rows, limit);
  }
}

const auditEntry = z.object({
  id: ulidSchema,
  at: z.iso.datetime(),
  actorType: z.enum(["user", "system", "api_key", "device"]),
  actorId: z.string().nullable(),
  requestId: z.string().nullable(),
  action: z.enum(["insert", "update", "delete"]),
  entityType: z.string(),
  entityId: ulidSchema,
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});

class AuditPageDto extends createZodDto(pageSchema(auditEntry)) {}
class AuditQueryDto extends createZodDto(
  paginationQuery.extend({
    entity_type: z
      .string()
      .regex(/^[a-z_]+$/)
      .max(60)
      .optional(),
    entity_id: ulidSchema.optional(),
  }),
) {}

@ApiTags("audit")
@Controller("v1/audit-logs")
@RequirePermission("audit:read")
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  @Isolation({ fixture: "audit" })
  @ZodResponse({ type: AuditPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: AuditQueryDto) {
    const p = await this.audit.list(ctx, { entityType: q.entity_type, entityId: q.entity_id }, q.cursor, q.limit);
    return {
      items: p.items.map((r) => ({
        id: r.id,
        at: r.createdAt.toISOString(),
        actorType: r.actorType,
        actorId: r.actorId,
        requestId: r.requestId,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        before: r.before,
        after: r.after,
      })),
      next_cursor: p.next_cursor,
    };
  }
}

@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}

@Module({ imports: [AuditModule], controllers: [AuditController] })
export class AuditHttpModule {}
