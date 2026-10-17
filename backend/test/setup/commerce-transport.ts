import { createHmac } from "node:crypto";
import type { CommerceOperation, CommercePrincipalKind } from "@omniseller/connector-core";
import { TIKTOK } from "./mock-marketplace";

interface Principal {
  kind: CommercePrincipalKind;
  shopCipher?: string | null;
  categoryCiphers?: string[];
}
export interface CommerceCall {
  operationId: string;
  url: URL;
  method: string;
  body: string;
  accessToken: string;
  form?: {
    fields: Record<string, string>;
    files: { field: string; filename: string; mime: string; bytes: Uint8Array }[];
  };
}
interface Reply {
  status?: number;
  data?: unknown;
  code?: number;
  message?: string;
  network?: boolean;
}
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Strict transport for reviewed operations. Connections still use MockMarketplace's signed HTTP server. */
export class CommerceTransport {
  readonly calls: CommerceCall[] = [];
  readonly violations: string[] = [];
  readonly principals = new Map<string, Principal>();
  onReply: ((call: CommerceCall) => Promise<void>) | undefined;
  private readonly replies = new Map<string, Reply[]>();
  constructor(
    private readonly operations: readonly CommerceOperation[],
    private readonly baseUrl: string,
  ) {}
  reset() {
    this.calls.length = 0;
    this.violations.length = 0;
    this.replies.clear();
    this.onReply = undefined;
  }
  reply(operation: CommerceOperation, ...replies: Reply[]) {
    this.replies.set(operation.id, replies);
  }
  count(operation: CommerceOperation) {
    return this.calls.filter((call) => call.operationId === operation.id).length;
  }
  private reject(message: string) {
    this.violations.push(message);
    return Response.json({ code: 106001, message: "Invalid test commerce request" }, { status: 401 });
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.origin !== new URL(this.baseUrl).origin) return this.reject("Unexpected commerce destination");
    const operation = this.operations.find(
      (item) =>
        item.method === method &&
        new RegExp(
          `^${item.path
            .split("/")
            .map((segment) => (/^\{[^}]+\}$/.test(segment) ? "[^/]+" : escapePattern(segment)))
            .join("/")}$`,
        ).test(url.pathname),
    );
    if (!operation?.available) return this.reject("Undocumented or unavailable commerce operation");
    const headers = new Headers(init?.headers);
    const token = headers.get("x-tts-access-token") ?? "";
    const principal = this.principals.get(token);
    if (!principal || principal.kind !== operation.principalKind)
      return this.reject("Wrong or missing principal token");
    if (url.searchParams.has("access_token") || url.searchParams.has("app_secret"))
      return this.reject("Credential leaked into signed API query");
    if (url.searchParams.get("app_key") !== TIKTOK.appKey) return this.reject("Wrong application key");
    const timestamp = Number(url.searchParams.get("timestamp"));
    if (!Number.isSafeInteger(timestamp) || Math.abs(timestamp * 1000 - Date.now()) > 300_000)
      return this.reject("Invalid request timestamp");
    if (principal.kind === "seller" && url.searchParams.get("shop_cipher") !== principal.shopCipher)
      return this.reject("Seller shop cipher missing or swapped");
    if (principal.kind !== "seller" && url.searchParams.has("shop_cipher"))
      return this.reject("Seller cipher sent with creator/partner token");
    if (
      operation.categoryAsset &&
      !principal.categoryCiphers?.includes(url.searchParams.get("category_asset_cipher") ?? "")
    )
      return this.reject("Partner private category asset missing or swapped");
    const body = typeof init?.body === "string" ? init.body : "";
    let form: CommerceCall["form"];
    if (operation.transport === "multipart") {
      if (!(init?.body instanceof FormData)) return this.reject("Multipart operation did not send FormData");
      if (headers.has("content-type")) return this.reject("Multipart boundary must be selected by fetch");
      form = { fields: {}, files: [] };
      for (const [field, value] of init.body.entries()) {
        const definition = operation.fields.find((item) => item.name === `body.${field}`);
        if (!definition) return this.reject("Undocumented multipart field");
        if (typeof value === "string") {
          if (definition.type === "file") return this.reject("Media identifier sent instead of actual file bytes");
          form.fields[field] = value;
        } else {
          if (definition.type !== "file") return this.reject("Unexpected multipart blob");
          form.files.push({
            field,
            filename: value.name,
            mime: value.type,
            bytes: new Uint8Array(await value.arrayBuffer()),
          });
        }
      }
      for (const field of operation.fields.filter((item) => item.type === "file" && item.required))
        if (!form.files.some((file) => `body.${file.field}` === field.name))
          return this.reject("Required multipart file missing");
    }
    const params = [...url.searchParams]
      .filter(([key]) => key !== "sign" && key !== "access_token")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}${value}`)
      .join("");
    const signature = createHmac("sha256", TIKTOK.appSecret)
      .update(`${TIKTOK.appSecret}${url.pathname}${params}${body}${TIKTOK.appSecret}`)
      .digest("hex");
    if (url.searchParams.get("sign") !== signature)
      return this.reject("HMAC does not match actual signed body and query");
    const call: CommerceCall = {
      operationId: operation.id,
      url,
      method,
      body,
      accessToken: token,
      ...(form ? { form } : {}),
    };
    this.calls.push(call);
    await this.onReply?.(call);
    const reply = this.replies.get(operation.id)?.shift() ?? { data: {} };
    if (reply.network) throw new TypeError("Fixture connection closed after receiving request");
    return Response.json(
      { code: reply.code ?? 0, message: reply.message ?? "Success", data: reply.data ?? {} },
      { status: reply.status ?? 200 },
    );
  };
}
