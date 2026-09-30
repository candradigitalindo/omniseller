import { Injectable, type NestMiddleware } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { NextFunction, Request, Response } from "express";
import { runWithAmbient } from "./request-context";

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * First in the chain (backend doc 8.1): take X-Request-Id from the edge or create a ULID, echo it
 * back, and run the rest of the request inside the ambient context used by logging and errors.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header("x-request-id");
    const requestId = incoming && SAFE_ID.test(incoming) ? incoming : newId();
    res.setHeader("X-Request-Id", requestId);
    runWithAmbient({ requestId, traceId: requestId }, () => next());
  }
}
