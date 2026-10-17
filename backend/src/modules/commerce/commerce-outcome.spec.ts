import { AuthExpiredError, PermanentConnectorError, TransientConnectorError } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { writeOutcomeUncertain } from "./commerce-outcome";

describe("marketplace mutation outcomes", () => {
  it("recognizes explicit API refusals and preflight failures as rejected", () => {
    for (const error of [
      new PermanentConnectorError({ code: "105005", message: "insufficient permission", httpStatus: 400 }),
      new PermanentConnectorError({ code: "invalid_parameter", message: "invalid", httpStatus: 200 }),
      new AuthExpiredError({ code: "105002", message: "expired" }),
      new PermanentConnectorError({ code: "commerce_invalid_file", message: "no valid file" }),
      new TransientConnectorError({ code: "local_rate_limit", message: "local budget" }),
      new TransientConnectorError({ code: "429", message: "remote limit", httpStatus: 429 }),
    ])
      expect(writeOutcomeUncertain(error, true)).toBe(false);
  });
  it("keeps network, server, malformed acknowledgement and partial results uncertain", () => {
    for (const error of [
      new TransientConnectorError({ code: "network", message: "timeout" }),
      new TransientConnectorError({ code: "http_503", message: "server", httpStatus: 503 }),
      new PermanentConnectorError({ code: "bad_response", message: "malformed success" }),
      new PermanentConnectorError({ code: "commerce_partial_failure", message: "some applied" }),
      new Error("worker lost response"),
    ])
      expect(writeOutcomeUncertain(error, true)).toBe(true);
  });
  it("never labels an unsent write uncertain and retains uncertainty after a later local failure", () => {
    expect(writeOutcomeUncertain(new Error("before sending"), false)).toBe(false);
    expect(
      writeOutcomeUncertain(
        new PermanentConnectorError({ code: "permission_revoked", message: "after acknowledgement" }),
        true,
        true,
      ),
    ).toBe(true);
  });
});
