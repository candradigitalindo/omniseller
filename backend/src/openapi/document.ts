import { type INestApplication, RequestMethod } from "@nestjs/common";
import { HTTP_CODE_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { ModulesContainer } from "@nestjs/core";
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { cleanupOpenApiDoc } from "nestjs-zod";
import { DEVICE_AUTH_SCHEME } from "../common/http/decorators";
import { SESSION_COOKIE } from "../common/http/request";

const OPERATIONS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/**
 * The status each handler answers on success, keyed like the document's operation ids
 * (`OrdersController_list`): its `@HttpCode`, else Nest's own default (201 for POST, 200 otherwise).
 */
export function successStatuses(app: INestApplication): Map<string, number> {
  const out = new Map<string, number>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const type = wrapper.metatype as (abstract new (...args: never[]) => unknown) | null;
      if (!type?.prototype) continue;
      const proto = type.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === "constructor" || typeof handler !== "function") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const code = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
        out.set(`${type.name}_${name}`, code ?? (method === RequestMethod.POST ? 201 : 200));
      }
    }
  }
  return out;
}

/**
 * A response documented without a status (`@ZodResponse` without `status`) comes out as `default`, which
 * generated clients read as the error answer (openapi-fetch gave every such call `data: never`). It is
 * the success answer, under the status the handler really sends.
 */
export function nameSuccessStatuses(doc: OpenAPIObject, statuses: Map<string, number>): void {
  for (const item of Object.values(doc.paths)) {
    for (const verb of OPERATIONS) {
      const op = item[verb];
      if (!op?.operationId || !op.responses?.default) continue;
      const status = statuses.get(op.operationId);
      if (status === undefined || op.responses[String(status)]) continue;
      op.responses[String(status)] = op.responses.default;
      delete op.responses.default;
    }
  }
}

/** OpenAPI 3.1 document of the api process (backend doc 10.4), generated from controllers and Zod DTOs. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("OmniSeller API")
    .setDescription("REST API v1. Errors are application/problem+json (RFC 9457).")
    .setVersion("1")
    .setOpenAPIVersion("3.1.0")
    .addCookieAuth(SESSION_COOKIE)
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "opaque", description: "Token agen cetak (backend doc 8.24)" },
      DEVICE_AUTH_SCHEME,
    )
    .build();
  const doc = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config), { version: "3.1" });
  nameSuccessStatuses(doc, successStatuses(app));
  return doc;
}
