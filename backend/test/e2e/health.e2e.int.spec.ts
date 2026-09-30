import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { AppModule } from "../../src/app.module";
import { parseEnv } from "../../src/config/env.schema";

describe("api process (backend doc 8.1, 10.1, 10.3)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const infra = inject("infra");
    const env = parseEnv({
      APP_ROLE: "api",
      NODE_ENV: "test",
      DATABASE_URL: infra.urls.api,
      REDIS_QUEUE_URL: infra.redisUrl,
      REDIS_CACHE_URL: infra.redisUrl,
      PUBLIC_WEB_URL: "http://localhost:3100",
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forEnv(env)] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("GET /healthz answers without touching dependencies", async () => {
    const res = await request(app.getHttpServer()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz checks the database and both Redis connections", async () => {
    const res = await request(app.getHttpServer()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", checks: { redis_queue: "ok", redis_cache: "ok", database: "ok" } });
  });

  it("echoes a request id and renders errors as problem+json", async () => {
    const res = await request(app.getHttpServer()).get("/v1/nothing-here").set("X-Request-Id", "cf-ray-1234abcd");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.headers["x-request-id"]).toBe("cf-ray-1234abcd");
    expect(res.body).toMatchObject({
      status: 404,
      code: "route.not_found",
      instance: "cf-ray-1234abcd",
      title: "Tidak ditemukan",
    });
  });

  it("creates a ULID request id when the edge sent none", async () => {
    const res = await request(app.getHttpServer()).get("/healthz");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
