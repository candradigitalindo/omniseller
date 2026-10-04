import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

/** Check every row of an uploaded file against its mapping, without writing anything (FR-MIG-01). */
export const migrationValidateRequested = defineEvent({
  type: "migration.validate_requested",
  aggregate: "migration_job",
  schema: z.object({ jobId: ulidSchema }),
});

/** Import a validated file: products, variants, and initial stock, all or nothing (FR-MIG-01). */
export const migrationImportRequested = defineEvent({
  type: "migration.import_requested",
  aggregate: "migration_job",
  schema: z.object({ jobId: ulidSchema }),
});
