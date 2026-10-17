import { describe, expect, it } from "vitest";
import { currentGrantedScopes, requireGrantedScopes, withGrantedScopes } from "./scope-context.js";

describe("verified grant scope context", () => {
  it("isolates concurrent/nested principal grants and copies the caller's metadata", async () => {
    const scopes = ["seller.product.basic"];
    await withGrantedScopes({ principalKind: "seller", scopes }, async () => {
      scopes.push("seller.product.write");
      expect(() => requireGrantedScopes(["seller.product.write"])).toThrowError(/missing_scope/);
      await Promise.all([
        withGrantedScopes({ principalKind: "creator", scopes: ["creator.video.write"] }, async () => {
          await Promise.resolve();
          expect(currentGrantedScopes()?.principalKind).toBe("creator");
          expect(() => requireGrantedScopes(["seller.product.basic"])).toThrowError(/missing_scope/);
        }),
        Promise.resolve().then(() => expect(currentGrantedScopes()?.principalKind).toBe("seller")),
      ]);
      expect(currentGrantedScopes()?.scopes).toEqual(["seller.product.basic"]);
    });
    expect(currentGrantedScopes()).toBeUndefined();
  });
  it("does not invent a scope contract or imply write from read", () => {
    withGrantedScopes({ principalKind: "seller", scopes: ["seller.product.basic"] }, () => {
      expect(() => requireGrantedScopes(["seller.product.basic"])).not.toThrow();
      expect(() => requireGrantedScopes(["seller.product.write"])).toThrowError(/missing_scope/);
      expect(() => requireGrantedScopes([])).toThrowError(/scope_contract_unverified/);
      expect(() => requireGrantedScopes(["seller.product.basic", "seller.product.write"], "any")).not.toThrow();
      expect(() => requireGrantedScopes(["seller.order.info", "seller.logistics"], "any")).toThrowError(
        /missing_scope/,
      );
    });
  });
});
