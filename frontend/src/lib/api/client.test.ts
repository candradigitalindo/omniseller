import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, problem } from "@/test/render";
import { api, handleSessionEnded, unwrap } from "./client";
import { ApiError } from "./errors";

describe("api client", () => {
  afterEach(() => handleSessionEnded(null));

  it("unwraps data and turns Problem Details into an ApiError", async () => {
    mockApi({
      "GET /v1/orders/summary": () => ({
        statuses: {},
        overdue: 0,
        dueSoon: 0,
        codOutstanding: { orders: 0, total: 0 },
      }),
      "GET /v1/orders/01JORDER000000000000000001": () => problem(404, "order.not_found", "Pesanan tidak ditemukan."),
    });
    await expect(unwrap(api.GET("/v1/orders/summary"))).resolves.toMatchObject({ overdue: 0 });
    const error = await unwrap(
      api.GET("/v1/orders/{id}", { params: { path: { id: "01JORDER000000000000000001" } } }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: "order.not_found", detail: "Pesanan tidak ditemukan." });
  });

  it("reports an ended session once per 401, except from the sign-in routes", async () => {
    const ended = vi.fn();
    handleSessionEnded(ended);
    mockApi({
      "GET /v1/orders/summary": () => problem(401, "auth.unauthenticated", "Sesi berakhir."),
      "POST /v1/auth/login": () => problem(401, "auth.invalid_credentials", "Email atau kata sandi salah."),
    });
    await unwrap(api.POST("/v1/auth/login", { body: { email: "a@example.test", password: "x" } })).catch(() => {});
    expect(ended).not.toHaveBeenCalled();
    await unwrap(api.GET("/v1/orders/summary")).catch(() => {});
    expect(ended).toHaveBeenCalledTimes(1);
  });
});
