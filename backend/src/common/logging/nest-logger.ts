import type { LoggerService } from "@nestjs/common";
import { logger } from "@omniseller/logging";

/** Routes NestJS framework logs into the same JSON logger. */
export class NestPinoLogger implements LoggerService {
  private readonly pino = logger.forModule("nest");

  log(message: unknown, context?: string): void {
    this.pino.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.pino.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.pino.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.pino.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.pino.trace({ context }, String(message));
  }
}
