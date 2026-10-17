/** A reviewed marketplace operation. URLs and credentials are always selected by the server. */
export type CommercePrincipalKind = "seller" | "creator" | "affiliate_partner";
export type CommerceValue = string | number | boolean | null | CommerceValue[] | { [key: string]: CommerceValue };
export interface CommerceField {
  name: string;
  label: string;
  type: "string" | "integer" | "number" | "boolean" | "enum" | "object" | "array" | "file";
  required: boolean;
  /** An empty initial cursor can be required by the API without representing missing input. */
  allowEmpty?: boolean;
  description?: string;
  options?: string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxBytes?: number;
  minBytes?: number;
  maxBytesByMime?: Record<string, number>;
  accept?: string[];
  timestampUnit?: "seconds" | "milliseconds";
  format?: "money" | "date" | "datetime" | "time";
  children?: CommerceField[];
  itemType?: "string" | "integer" | "number" | "boolean" | "object";
}
export interface CommerceOperation {
  id: string;
  channel: "tiktokshop" | "shopee";
  principalKind: CommercePrincipalKind;
  title: string;
  group: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  scopes: string[];
  /** Shopee grants app programs in its Console rather than returning OAuth scopes per shop. */
  authMode?: "oauth_scope" | "shopee_app_program";
  appPrograms?: string[];
  eligibility?: "unverified";
  eligibilityReason?: string;
  scopeMode?: "all" | "any";
  accountRequirements?: ("cross_border" | "local")[];
  write: boolean;
  officialUrl: string;
  fields: CommerceField[];
  available: boolean;
  /** Application roles needed in addition to marketplace permission, computed by the owning service. */
  requiredPermissions?: string[];
  unavailableReason: string | null;
  /** Only validated public response fields are retained. Private assets never leave the connector. */
  responseFields?: string[];
  categoryAsset?: boolean;
  transport?: "json" | "multipart" | "private_download" | "large_upload";
}
export interface CommerceInput {
  /** Public category id chosen from the connected partner profile; the cipher stays server-side. */
  categoryAssetId?: number;
  path?: Record<string, CommerceValue>;
  query?: Record<string, CommerceValue>;
  body?: Record<string, CommerceValue>;
}
export interface CommerceCredentials {
  accessToken: string;
  externalShopId?: string;
  shopCipher?: string | null;
  categoryAssets?: { cipher: string; categoryId: number; categoryName: string; market: string }[];
  files?: Record<
    string,
    {
      bytes: Uint8Array;
      mime: string;
      filename: string;
      size?: number;
      readRange?: (start: number, endExclusive: number) => Promise<Uint8Array>;
    }
  >;
}
export interface CommerceResult {
  data: CommerceValue;
  nextCursor: string | null;
  /** Success means an API acknowledgement. Marketplace processing may finish later. */
  acknowledgement: "read" | "accepted";
  artifact?: { fileId: string; mime: string; sizeBytes: number; expiresAt: string };
}
export interface CommerceExecutionResult extends CommerceResult {
  /** Worker saves the bytes privately, discarding them before retaining the request result. */
  download?: { bytes: Uint8Array; mime: string; ext: string };
}
export interface MarketplaceCommerce {
  operations: readonly CommerceOperation[];
  execute(
    credentials: CommerceCredentials,
    operationId: string,
    input: CommerceInput,
  ): Promise<CommerceExecutionResult>;
}
