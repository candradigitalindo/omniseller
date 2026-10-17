import { AsyncLocalStorage } from "node:async_hooks";
import type { CommercePrincipalKind } from "./commerce-types.js";
import { PermanentConnectorError } from "./errors.js";

export interface GrantedScopes {
  readonly principalKind: CommercePrincipalKind;
  readonly scopes: readonly string[];
}
const context = new AsyncLocalStorage<GrantedScopes>();

/** Worker request boundary. Carries verified grant metadata only, never credentials. */
export function withGrantedScopes<T>(grant: GrantedScopes, fn: () => T): T {
  return context.run({ principalKind: grant.principalKind, scopes: Object.freeze([...grant.scopes]) }, fn);
}
export function currentGrantedScopes(): GrantedScopes | undefined {
  return context.getStore();
}

/** No implicit scope expansion: read permission never implies write permission. */
export function requireGrantedScopes(required: readonly string[], mode: "all" | "any" = "all"): void {
  const grant = context.getStore();
  if (!grant) return;
  if (required.length === 0)
    throw new PermanentConnectorError({
      code: "scope_contract_unverified",
      message: "Documented scope contract is unavailable",
    });
  const granted = new Set(grant.scopes);
  const missing = required.filter((scope) => !granted.has(scope));
  if (mode === "any" ? missing.length === required.length : missing.length > 0)
    throw new PermanentConnectorError({
      code: "missing_scope",
      message:
        mode === "any"
          ? `Account grant lacks an applicable documented API scope: ${required.join(", ")}`
          : `Account grant lacks API scopes: ${missing.join(", ")}`,
    });
}
