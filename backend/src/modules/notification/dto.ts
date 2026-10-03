import { ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { MAX_LIMIT, pageSchema } from "../../common/http/pagination";
import type { NotificationRow } from "./inbox.repository";

const iso = z.iso.datetime();

export class NotificationQueryDto extends createZodDto(
  z.object({
    unread: z.enum(["true", "false"]).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
  }),
) {}

const notificationSchema = z.object({
  id: ulidSchema,
  kind: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.unknown()),
  readAt: iso.nullable(),
  createdAt: iso,
});

export class NotificationPageDto extends createZodDto(pageSchema(notificationSchema)) {}
export class UnreadCountDto extends createZodDto(z.object({ unread: z.number().int() })) {}

export class MarkReadDto extends createZodDto(
  z
    .object({
      ids: z.array(ulidSchema).min(1).max(500).optional(),
      /** Every unread notification of the caller. */
      all: z.boolean().optional(),
    })
    .refine((b) => !!b.ids !== !!b.all, { message: "Isi ids atau all, salah satu saja." }),
) {}

export class MarkedDto extends createZodDto(z.object({ marked: z.number().int() })) {}

export function notificationView(n: NotificationRow): z.infer<typeof notificationSchema> {
  return {
    id: n.id,
    kind: n.kind,
    severity: n.severity,
    title: n.title,
    body: n.body,
    data: n.data,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}
