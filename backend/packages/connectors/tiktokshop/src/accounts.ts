import {
  type MarketplaceAccountAuth,
  type MarketplaceAccountGrant,
  type MarketplaceAccountKind,
  PermanentConnectorError,
} from "@omniseller/connector-core";
import type { TiktokShopClient } from "./client.js";

const USER_TYPES = { creator: 1, affiliate_partner: 3 } as const;
const MINIMUM_SCOPES = { creator: "creator.affiliate.info", affiliate_partner: "partner.authorization.info" } as const;
function badResponse(): never {
  throw new PermanentConnectorError({ code: "bad_response", message: "Invalid account authorization response" });
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return badResponse();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return badResponse();
  return value;
}
function list(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return badResponse();
  return [...new Set(value as string[])];
}
function expiry(value: unknown): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return badResponse();
  const d = new Date(value * 1000);
  if (!Number.isFinite(d.getTime())) return badResponse();
  return d;
}
function grant(value: unknown, kind: MarketplaceAccountKind): MarketplaceAccountGrant {
  const data = record(value);
  if (data.user_type !== USER_TYPES[kind])
    throw new PermanentConnectorError({
      code: "wrong_user_type",
      message: "Authorization principal does not match the requested account type",
    });
  const scopes = list(data.granted_scopes);
  if (!scopes.includes(MINIMUM_SCOPES[kind]))
    throw new PermanentConnectorError({ code: "missing_scope", message: "Minimum account scope was not granted" });
  return {
    kind,
    externalPrincipalId: text(data.open_id),
    tokens: {
      accessToken: text(data.access_token),
      refreshToken: text(data.refresh_token),
      accessExpiresAt: expiry(data.access_token_expire_in),
      refreshExpiresAt: expiry(data.refresh_token_expire_in),
      scopes,
    },
  };
}
/** Official ROW creator/partner authorization, distinct from the seller service URL. */
export function tiktokAccounts(client: TiktokShopClient): MarketplaceAccountAuth {
  return {
    authorizeUrl({ state, kind }) {
      if (!state.trim()) throw new PermanentConnectorError({ code: "invalid_request", message: "State is required" });
      const url = new URL(
        kind === "creator"
          ? (client.config.creatorAuthorizeUrl ?? "https://shop.tiktok.com/alliance/creator/auth")
          : (client.config.partnerAuthorizeUrl ?? "https://partner.tiktokshop.com/open/authorize"),
      );
      if (kind === "creator") url.searchParams.set("app_key", client.appKey);
      else {
        if (!client.config.serviceId)
          throw new PermanentConnectorError({ code: "not_configured", message: "Service ID is required" });
        url.searchParams.set("service_id", client.config.serviceId);
      }
      url.searchParams.set("state", state);
      return url.toString();
    },
    async exchangeCode({ code, kind }) {
      return grant(
        await client.token<unknown>("/api/v2/token/get", { auth_code: code, grant_type: "authorized_code" }),
        kind,
      );
    },
    async refresh({ refreshToken, kind, externalPrincipalId }) {
      const result = grant(
        await client.token<unknown>("/api/v2/token/refresh", {
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
        kind,
      );
      if (result.externalPrincipalId !== externalPrincipalId)
        throw new PermanentConnectorError({
          code: "principal_changed",
          message: "Refreshed token belongs to another account",
        });
      return result;
    },
    async describe({ accessToken, kind, scopes }) {
      if (!scopes.includes(MINIMUM_SCOPES[kind]))
        throw new PermanentConnectorError({ code: "missing_scope", message: "Minimum account scope was not granted" });
      if (kind === "creator") {
        const data = record(
          await client.call<unknown>({ method: "GET", path: "/affiliate_creator/202508/profiles", accessToken }),
        );
        const region = text(data.selection_region).toUpperCase();
        if (region !== "ID")
          throw new PermanentConnectorError({
            code: "region_not_supported",
            message: "Creator selection region must be Indonesia",
          });
        return {
          displayName: text(data.username),
          region,
          info: {
            creator_user_open_id: text(data.creator_user_open_id),
            register_region: typeof data.register_region === "string" ? data.register_region : null,
            user_type: typeof data.user_type === "string" ? data.user_type : null,
            permissions: list(data.permissions),
          },
          categoryAssets: [],
        };
      }
      const data = record(
        await client.call<unknown>({ method: "GET", path: "/authorization/202405/category_assets", accessToken }),
      );
      if (!Array.isArray(data.category_assets)) return badResponse();
      const assets = data.category_assets
        .map((value) => {
          const asset = record(value);
          const category = record(asset.category);
          if (typeof category.id !== "number" || !Number.isSafeInteger(category.id) || category.id <= 0)
            return badResponse();
          return {
            cipher: text(asset.cipher),
            market: text(asset.target_market).toUpperCase(),
            categoryId: category.id,
            categoryName: text(category.name),
          };
        })
        .filter((asset) => asset.market === "ID");
      if (!assets.length)
        throw new PermanentConnectorError({
          code: "region_not_supported",
          message: "No authorized category asset for Indonesia",
        });
      return {
        displayName: null,
        region: "ID",
        info: {
          categories: assets.map(({ categoryId, categoryName, market }) => ({
            id: categoryId,
            name: categoryName,
            market,
          })),
        },
        categoryAssets: assets,
      };
    },
  };
}
