import {
  errorOfKind,
  isConnectorError,
  type MarketplaceAccountAuth,
  type MarketplaceAccountGrant,
  type MarketplaceAccountKind,
  PermanentConnectorError,
} from "@omniseller/connector-core";
import { accessExpiry, ShopeeClient, type ShopeeEnvelope } from "./client.js";
import { acknowledgedMedia } from "./commerce-media.js";
import { numericId, shopeeId } from "./identifiers.js";

const REFRESH_LIFETIME_MS = 30 * 24 * 3600 * 1000;
const invalid = (code = "bad_response"): never => {
  throw new PermanentConnectorError({ code, message: "Respons otorisasi akun Shopee tidak valid." });
};
function creator(kind: MarketplaceAccountKind): void {
  if (kind !== "creator") invalid("account_kind_unsupported");
}
function program(value: unknown): "video" | "live" {
  if (value !== "video" && value !== "live") return invalid("account_program_required");
  return value;
}
interface UserGrant extends ShopeeEnvelope {
  user_id_list?: unknown;
  user_id?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  expire_in?: unknown;
}
function grant(value: UserGrant, externalId?: string): MarketplaceAccountGrant {
  acknowledgedMedia(value);
  const id =
    externalId === undefined
      ? Array.isArray(value.user_id_list) && value.user_id_list.length === 1
        ? shopeeId(value.user_id_list[0])
        : null
      : shopeeId(value.user_id);
  if (!id || id === "0" || (externalId !== undefined && id !== externalId)) return invalid("principal_changed");
  if (
    typeof value.access_token !== "string" ||
    !value.access_token.trim() ||
    typeof value.refresh_token !== "string" ||
    !value.refresh_token.trim() ||
    typeof value.expire_in !== "number" ||
    !Number.isSafeInteger(value.expire_in) ||
    value.expire_in <= 0
  )
    return invalid();
  const now = new Date();
  const accessExpiresAt = accessExpiry(value.expire_in, now);
  if (accessExpiresAt.getTime() <= now.getTime()) return invalid();
  return {
    kind: "creator",
    externalPrincipalId: id,
    tokens: {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      accessExpiresAt,
      refreshExpiresAt: new Date(now.getTime() + REFRESH_LIFETIME_MS),
      // Shopee grants app programs in its Console. Never invent OAuth scopes from app names.
      scopes: [],
    },
  };
}

/** Guides 669 and 706: affiliate streamers and Video creators authorize a separate user principal. */
export function shopeeAccounts(client: ShopeeClient): MarketplaceAccountAuth {
  const authClient = new ShopeeClient({
    ...client.config,
    http: {
      ...client.config.http,
      observer(record) {
        client.config.http?.observer?.({
          method: record.method,
          path: record.path.split("?")[0]!,
          httpStatus: record.httpStatus,
          durationMs: record.durationMs,
          request: { accountAuthorization: true },
          response: { redacted: true },
        });
      },
    },
  });
  const tokenCall = async (path: string, body: object): Promise<UserGrant> => {
    try {
      return await authClient.publicCall<UserGrant>("POST", path, { body });
    } catch (error) {
      if (isConnectorError(error))
        throw errorOfKind(error.kind, {
          code: /^[a-z][a-z0-9_.-]{0,95}$/i.test(error.code) ? error.code : "account_authorization_failed",
          message: "Otorisasi akun Shopee tidak dapat diselesaikan.",
          ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
          ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        });
      return invalid("account_authorization_failed");
    }
  };
  return {
    authorizeUrl(input) {
      creator(input.kind);
      program(input.program);
      if (!input.state.trim() || !client.config.accountRedirectUri) return invalid("not_configured");
      const url = new URL("/auth", client.config.authBaseUrl);
      url.searchParams.set("partner_id", String(client.config.partnerId));
      url.searchParams.set("auth_type", "user");
      url.searchParams.set("redirect_uri", client.config.accountRedirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", input.state);
      return url.toString();
    },
    async exchangeCode(input) {
      creator(input.kind);
      program(input.program);
      if (!input.code.trim()) return invalid("invalid_request");
      return grant(
        await tokenCall("/api/v2/auth/token/get", { partner_id: client.config.partnerId, code: input.code }),
      );
    },
    async refresh(input) {
      creator(input.kind);
      program(input.program);
      const id = shopeeId(input.externalPrincipalId);
      if (!id || !input.refreshToken.trim()) return invalid("invalid_request");
      return grant(
        await tokenCall("/api/v2/auth/access_token/get", {
          partner_id: client.config.partnerId,
          user_id: numericId(id),
          refresh_token: input.refreshToken,
        }),
        id,
      );
    },
    async describe(input) {
      creator(input.kind);
      const selectedProgram = program(input.program);
      if (!shopeeId(input.externalPrincipalId)) return invalid("invalid_request");
      // These public contracts expose no account-country/profile lookup. ID is the selected
      // application market; it must never be presented as a country verified by Shopee.
      return {
        displayName: null,
        region: "ID",
        regionVerified: false,
        categoryAssets: [],
        info: { program: selectedProgram, regionVerification: "unverified", appEligibility: "unverified" },
      };
    },
  };
}
