import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineEvent, defineJob } from "./define";
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
