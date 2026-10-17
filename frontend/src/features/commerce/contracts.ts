import type { MethodResponse } from "openapi-fetch";
import type { Api } from "@/lib/api/client";
import type { paths } from "@/lib/api/schema";

export type CommerceOperation =
  paths["/v1/commerce/operations"]["get"]["responses"][200]["content"]["application/json"]["items"][number];
export type CommerceField = CommerceOperation["fields"][number];
export type CommercePrincipal =
  paths["/v1/commerce/principals"]["get"]["responses"][200]["content"]["application/json"]["items"][number];
export type CommerceRequest = MethodResponse<Api, "get", "/v1/commerce/requests/{id}">;
export type CommerceInput =
  paths["/v1/commerce/requests"]["post"]["requestBody"]["content"]["application/json"]["input"];
