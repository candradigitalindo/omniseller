import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { ImportRunnerService } from "./import-runner.service";
import { migrationImportRequested, migrationValidateRequested } from "./migration.events";

/**
 * FR-MIG-01: checks every row of an uploaded file, nothing written. Runs once per request (the seller
 * may validate the same file again after fixing the catalog); a failed run says so on the job.
 */
export const migrationValidateJob = defineJob({
  queue: "import",
  name: "migration.validate",
  schema: z.object({ jobId: ulidSchema }),
  triggeredBy: [migrationValidateRequested],
  options: { attempts: 1 },
  jobId: (p, meta) => jobKey("migration.validate", p.jobId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(ImportRunnerService).validate(run.ctx, p.jobId);
  },
});

/** FR-MIG-01: imports a validated file, all rows or none, together with the job's status. */
export const migrationImportJob = defineJob({
  queue: "import",
  name: "migration.import",
  schema: z.object({ jobId: ulidSchema }),
  triggeredBy: [migrationImportRequested],
  options: { attempts: 1 },
  jobId: (p, meta) => jobKey("migration.import", p.jobId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(ImportRunnerService).import(run.ctx, p.jobId);
  },
});

export const MIGRATION_JOBS = [migrationValidateJob, migrationImportJob];
