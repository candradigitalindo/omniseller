import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { cleanupOpenApiDoc } from "nestjs-zod";
import { DEVICE_AUTH_SCHEME } from "../common/http/decorators";
import { SESSION_COOKIE } from "../common/http/request";

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
  return cleanupOpenApiDoc(SwaggerModule.createDocument(app, config), { version: "3.1" });
}
