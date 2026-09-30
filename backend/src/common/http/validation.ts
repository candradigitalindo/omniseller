import { type ArgumentMetadata, Injectable } from "@nestjs/common";
import { createZodValidationPipe } from "nestjs-zod";
import type { ZodError } from "zod";
import { ValidationError } from "../errors/domain-errors";

const StrictZodValidationPipe = createZodValidationPipe({
  strictSchemaDeclaration: true,
  createValidationException: (error: unknown) =>
    new ValidationError(
      (error as ZodError).issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    ),
});

/**
 * Global request validation (backend doc 8.1 step 6). Every @Body, @Query, and @Param must be a
 * nestjs-zod DTO (strictSchemaDeclaration), and failures become 422 validation.failed with field paths.
 * Custom parameter decorators such as @Ctx() carry server-built values, not client input, and are
 * passed through untouched.
 */
@Injectable()
export class AppValidationPipe extends StrictZodValidationPipe {
  override transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type === "custom") return value;
    return super.transform(value, metadata);
  }
}
