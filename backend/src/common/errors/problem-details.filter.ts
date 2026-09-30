import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import type { Response } from "express";
import { ambient } from "../context/request-context";
import { RateLimitedError } from "./domain-errors";
import { toProblem } from "./problem";

const log = logger.forModule("http");

/** Turns every error into application/problem+json (RFC 9457). */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = ambient()?.requestId ?? newId();
    const problem = toProblem(err, requestId);
    if (problem.status >= 500) {
      log.error({ err, code: problem.code }, "request failed");
      // Sentry.captureException(err) is wired in the observability milestone.
    } else {
      log.info({ code: problem.code, status: problem.status }, "request rejected");
    }
    if (err instanceof RateLimitedError) res.setHeader("Retry-After", String(err.retryAfterSeconds));
    res.status(problem.status).type("application/problem+json").send(problem);
  }
}
