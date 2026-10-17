import { currentGrantedScopes, PermanentConnectorError, requireGrantedScopes } from "@omniseller/connector-core";
import { TIKTOK_RUNTIME_SCOPE_CONTRACTS } from "./runtime-scope-contracts.js";

const PRINCIPAL_AUTH_TYPE = { seller: 1, creator: 2, affiliate_partner: 4 } as const;
const contracts = TIKTOK_RUNTIME_SCOPE_CONTRACTS.map((contract) => {
  const pattern = contract.path
    .split(/(\{[^}]+\})/g)
    .map((part) => (/^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return { contract, match: new RegExp(`^${pattern}$`), specificity: contract.path.replace(/\{[^}]+\}/g, "").length };
}).sort((a, b) => b.specificity - a.specificity);

/** Match exact method/version and literal segments before dynamic marketplace identifiers. */
export function tiktokRuntimeScopeContract(method: string, path: string) {
  return contracts.find((item) => item.contract.method === method && item.match.test(path))?.contract;
}

/** Applied before every signed HTTP request when the worker supplies verified grant metadata. */
export function assertTiktokRequestScopes(method: string, path: string): void {
  const grant = currentGrantedScopes();
  if (!grant) return;
  const contract = tiktokRuntimeScopeContract(method, path);
  if (!contract)
    throw new PermanentConnectorError({
      code: "scope_contract_unverified",
      message: "No reviewed scope contract for this API method/version",
    });
  const scopes = contract.scopes
    .filter((scope) => scope.authType === PRINCIPAL_AUTH_TYPE[grant.principalKind])
    .map((scope) => scope.name);
  // A matching documented package is a necessary local precheck, not proof of sufficiency or
  // entitlement. Ambiguous package semantics remain subject to the marketplace's final authorization.
  requireGrantedScopes(scopes, "any");
}
