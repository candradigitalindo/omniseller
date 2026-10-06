import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type RequestContext, systemContext } from "../common/context/request-context";
import type { Tx } from "../db/client";
import { Outbox } from "../outbox/outbox";
import { defineEvent, defineJob } from "./define";
import { jobContext } from "./job-context";
import { jobKey } from "./job-id";
import { JobRegistry } from "./registry";

describe("jobKey", () => {
  it("joins parts with a separator BullMQ accepts", () => {
    expect(jobKey("order.accept", "01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe("order.accept|01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("rejects parts that would break BullMQ ids or collide", () => {
    expect(() => jobKey("order.accept", "a:b")).toThrow(/invalid job id part/);
    expect(() => jobKey("x", "a|b")).toThrow(/invalid job id part/);
    expect(() => jobKey("x", "")).toThrow(/invalid job id part/);
    expect(() => jobKey(12345)).toThrow(/integer/);
  });
});

describe("JobRegistry", () => {
  const event = defineEvent({
    type: "order.accept_requested",
    aggregate: "order",
    schema: z.object({ orderId: z.string() }),
  });
  const job = defineJob({
    queue: "mp.outbound",
    name: "order.accept",
    schema: z.object({ orderId: z.string() }),
    triggeredBy: [event],
    jobId: (p) => jobKey("order.accept", p.orderId),
    handler: async () => {},
  });

  it("finds consumers of an event and lists their queues", () => {
    const registry = new JobRegistry([job]);
    expect(registry.consumersOf(event)).toEqual([job]);
    expect(registry.queues()).toEqual(["mp.outbound"]);
    expect(registry.get("mp.outbound", "order.accept")).toBe(job);
  });

  it("refuses duplicate registrations and malformed names", () => {
    expect(() => new JobRegistry([job, job])).toThrow(/registered twice/);
    expect(() => defineEvent({ type: "OrderAccepted", aggregate: "order", schema: z.object({}) })).toThrow();
    expect(() => defineJob({ ...job, name: "accept" })).toThrow();
  });
});

describe("jobs that carry out what a person asked for (backend doc 8.28)", () => {
  const event = defineEvent({
    type: "listing.status_push_requested",
    aggregate: "listing",
    schema: z.object({ storeId: z.string() }),
  });
  const acting = defineJob({
    queue: "mp.outbound",
    name: "listing.status_push",
    schema: z.object({ storeId: z.string() }),
    triggeredBy: [event],
    actsForRequester: true,
    jobId: (p) => jobKey("listing.status_push", p.storeId),
    handler: async () => {},
  });
  const plain = defineJob({
    queue: "mp.poll",
    name: "listing.pull",
    schema: z.object({ storeId: z.string() }),
    triggeredBy: [event],
    jobId: (p) => jobKey("listing.pull", p.storeId),
    handler: async () => {},
  });
  const user = { ...systemContext("T1"), actor: { type: "user" as const, id: "U1" } };

  async function enqueued(ctx: RequestContext) {
    const rows: { jobName: string; payload: Record<string, unknown> }[] = [];
    const tx = { insert: () => ({ values: async (r: typeof rows) => void rows.push(...r) }) } as unknown as Tx;
    await new Outbox(new JobRegistry([acting, plain])).enqueue(tx, ctx, event, { storeId: "S1" }, "S1");
    return Object.fromEntries(rows.map((r) => [r.jobName, r.payload]));
  }

  it("keeps who asked only for jobs that act for them, and never the system", async () => {
    expect(await enqueued(user)).toEqual({
      "listing.status_push": { storeId: "S1", tenantId: "T1", requestedBy: { type: "user", id: "U1" } },
      "listing.pull": { storeId: "S1", tenantId: "T1" },
    });
    expect(await enqueued(systemContext("T1"))).toEqual({
      "listing.status_push": { storeId: "S1", tenantId: "T1" },
      "listing.pull": { storeId: "S1", tenantId: "T1" },
    });
  });

  it("runs such a job as that person, with the system's permissions, and anything else as the system", () => {
    const asked = { storeId: "S1", requestedBy: { type: "user", id: "U1" } };
    const ctx = jobContext(acting, "T1", "J1", asked);
    expect(ctx.actor).toEqual({ type: "user", id: "U1" });
    expect(ctx.requestId).toBe("J1");
    expect(ctx.permissions).toEqual(systemContext("T1").permissions);
    expect(ctx.storeScope).toBeNull();
    expect(jobContext(plain, "T1", "J1", asked).actor).toEqual({ type: "system", id: "system" });
    // nothing usable kept: the system acts
    expect(jobContext(acting, "T1", "J1", { requestedBy: { type: "system", id: "system" } }).actor.type).toBe("system");
    expect(jobContext(acting, "T1", "J1", { requestedBy: "U1" }).actor.type).toBe("system");
    expect(jobContext(acting, "T1", "J1", null).actor.type).toBe("system");
    expect(jobContext(acting, "T1", undefined, {}).requestId).toMatch(/^[0-9A-Z]{26}$/);
  });
});
