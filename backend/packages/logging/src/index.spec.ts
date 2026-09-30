import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { configureLogger, createRootLogger, logger, setLogContextProvider } from "./index.js";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { lines, logger: createRootLogger({ level: "debug", destination: stream }) };
}

describe("logging", () => {
  it("redacts buyer PII and secrets at any depth", () => {
    const { lines, logger } = capture();
    logger.info(
      {
        order: { buyer_name: "Dewi A.", buyer_phone: "0812", shipping_address: { city: "Bandung" } },
        credential: { access_token_enc: "abc", token_hash: "def" },
        headers: { authorization: "Bearer x" },
        email: "a@b.c",
        safe: "ok",
      },
      "order.created",
    );
    const line = lines[0] as Record<string, any>;
    expect(line.order.buyer_name).toBe("[Redacted]");
    expect(line.order.buyer_phone).toBe("[Redacted]");
    expect(line.order.shipping_address).toBe("[Redacted]");
    expect(line.credential.access_token_enc).toBe("[Redacted]");
    expect(line.credential.token_hash).toBe("[Redacted]");
    expect(line.headers.authorization).toBe("[Redacted]");
    expect(line.email).toBe("[Redacted]");
    expect(line.safe).toBe("ok");
    expect(line.msg).toBe("order.created");
    expect(line.level).toBe("info");
  });

  it("module loggers created before configuration use the configured root", () => {
    const early = logger.forModule("early");
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(chunk.toString()));
        cb();
      },
    });
    configureLogger({ level: "info", destination: stream, base: { role: "worker" } });
    early.info("after configure");
    expect(lines[0]).toMatchObject({ role: "worker", module: "early", msg: "after configure" });
  });

  it("adds context fields from the provider", () => {
    const { lines, logger } = capture();
    setLogContextProvider(() => ({ request_id: "R1", tenant_id: "T1" }));
    logger.info("hello");
    setLogContextProvider(() => undefined);
    expect(lines[0]).toMatchObject({ request_id: "R1", tenant_id: "T1", msg: "hello" });
  });
});
