import {
  AuthExpiredError,
  AuthRevokedError,
  PermanentConnectorError,
  TransientConnectorError,
} from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { isOutage } from "./marketplace-gateway";

describe("isOutage (FR-INT-08)", () => {
  it("counts a marketplace that cannot be reached or is busy, not a bad request or OmniSeller's own pacing", () => {
    expect(isOutage(new TransientConnectorError({ code: "error_server", message: "System busy." }))).toBe(true);
    expect(isOutage(new TransientConnectorError({ code: "network", message: "socket hang up" }))).toBe(true);
    expect(isOutage(new TransientConnectorError({ code: "local_rate_limit", message: "budget used up" }))).toBe(false);
    expect(isOutage(new PermanentConnectorError({ code: "error_param", message: "Wrong item_id." }))).toBe(false);
    // lost authorization shows as the store's status instead
    expect(isOutage(new AuthExpiredError({ code: "invalid_access_token", message: "Invalid." }))).toBe(false);
    expect(isOutage(new AuthRevokedError({ code: "error_auth", message: "No permission." }))).toBe(false);
    expect(isOutage(new Error("bug"))).toBe(false);
  });
});
