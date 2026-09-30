import { NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConflictError } from "./domain-errors";
import { toProblem } from "./problem";

function pgError(fields: Record<string, string>) {
  return Object.assign(new Error(fields.message), { severity: "ERROR", ...fields });
}

describe("toProblem", () => {
  it("renders domain errors with their code and detail", () => {
    const p = toProblem(new ConflictError("order.invalid_transition", "Pesanan sudah dikirim."), "REQ1");
    expect(p).toEqual({
      type: "https://docs.omniseller.id/errors/order.invalid_transition",
      title: "Terjadi konflik",
      status: 409,
      detail: "Pesanan sudah dikirim.",
      instance: "REQ1",
      code: "order.invalid_transition",
    });
  });

  it("maps zod errors to 422 with field paths", () => {
    const r = z.object({ qty: z.number().int().positive() }).safeParse({ qty: -1 });
    const p = toProblem(r.error, "REQ");
    expect(p.status).toBe(422);
    expect(p.errors?.[0]?.path).toBe("qty");
  });

  it("maps codes raised by SQL functions, through a wrapping cause", () => {
    const wrapped = Object.assign(new Error("Failed query"), {
      cause: pgError({ code: "23514", message: "STOCK_INSUFFICIENT", detail: "on_hand=1 reserved=0" }),
    });
    const p = toProblem(wrapped, "REQ");
    expect(p).toMatchObject({ status: 409, code: "stock.insufficient", detail: "on_hand=1 reserved=0" });
  });

  it("maps business unique constraints to specific codes", () => {
    const p = toProblem(
      pgError({ code: "23505", message: "duplicate", constraint: "store_channel_external_shop_uq" }),
      "R",
    );
    expect(p).toMatchObject({ status: 409, code: "store.already_connected" });
  });

  it("distinguishes a missing reference from a row still in use", () => {
    const insert = pgError({ code: "23503", message: 'insert or update on table "x" violates foreign key constraint' });
    const del = pgError({ code: "23503", message: 'update or delete on table "x" violates foreign key constraint' });
    expect(toProblem(insert, "R")).toMatchObject({ status: 412, code: "row.reference_missing" });
    expect(toProblem(del, "R")).toMatchObject({ status: 409, code: "row.in_use" });
  });

  it("hides internal details and treats invariant breaks as 500", () => {
    const p = toProblem(pgError({ code: "42501", message: "TENANT_MISMATCH", detail: "secret" }), "R");
    expect(p).toMatchObject({ status: 500, code: "internal.tenant_mismatch" });
    expect(p.detail).toBeUndefined();
    expect(toProblem(new Error("boom"), "R")).toMatchObject({ status: 500, code: "internal" });
  });

  it("maps unknown routes to 404", () => {
    expect(toProblem(new NotFoundException(), "R")).toMatchObject({ status: 404, code: "route.not_found" });
  });
});
