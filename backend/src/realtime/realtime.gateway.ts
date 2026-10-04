import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { logger } from "@omniseller/logging";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Redis } from "ioredis";
import { Server, type Socket } from "socket.io";
import { RATE_RULES, type RateLimiter } from "../common/security/rate-limiter";
import { looksLikeSecretToken } from "../common/security/tokens";
import { ENV } from "../config/config.module";
import type { EnvFor } from "../config/env.schema";
import { RATE_LIMITER, REDIS_CACHE } from "../infra/tokens";
import { DevicesService } from "../modules/identity/devices.service";
import { deviceRoom, REALTIME, type Realtime } from "./realtime";

const log = logger.forModule("realtime");

/** Socket.IO's default path; the print agent connects to `<api>/socket.io` with its device token. */
export const REALTIME_PATH = "/socket.io";

interface SocketData {
  tenantId: string;
  deviceId: string;
}

/** Why a handshake was refused, as the client's `connect_error` message. */
class HandshakeRefused extends Error {}

/**
 * Socket.IO in the api process (technology doc 7.3, backend doc 8.24), on the same HTTP server as the
 * REST API, with the Redis adapter so that pushes published by any process (`Realtime`) reach the
 * instance holding the connection. Print agents connect with their device token (`auth.token`, or an
 * `Authorization: Bearer` header) and join their room `device:<id>`; they send nothing over the socket,
 * since reports go through the REST agent routes. Browser sessions join with the web app.
 *
 * Behind a load balancer the agent uses the WebSocket transport only: HTTP long-polling would need
 * sticky sessions across api instances.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private io: Server | undefined;
  private sub: Redis | undefined;

  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(REDIS_CACHE) private readonly redis: Redis,
    @Inject(REALTIME) private readonly realtime: Realtime,
    @Inject(ENV) private readonly env: EnvFor<"api">,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  onApplicationBootstrap(): void {
    this.sub = this.redis.duplicate();
    this.io = new Server(this.host.httpAdapter.getHttpServer(), {
      path: REALTIME_PATH,
      serveClient: false,
      cors: { origin: this.env.PUBLIC_WEB_URL, credentials: true },
      adapter: createAdapter(this.redis, this.sub, { key: this.realtime.channel }),
    });
    this.io.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (err: unknown) => {
          if (!(err instanceof HandshakeRefused)) log.error({ err }, "realtime handshake failed");
          next(err instanceof HandshakeRefused ? err : new Error("internal"));
        },
      );
    });
    this.io.on("connection", (socket) => {
      void socket.join(deviceRoom((socket.data as SocketData).deviceId));
    });
  }

  /** The device token, the business's status, and the per-tenant rate limit, as for REST (AuthGuard). */
  private async authenticate(socket: Socket): Promise<void> {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    const header = socket.handshake.headers.authorization;
    const token = auth?.token ?? (header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined);
    if (!looksLikeSecretToken(token)) throw new HandshakeRefused("auth.device_invalid");
    const device = await this.devices.authenticate(token);
    if (device?.kind !== "print_agent") throw new HandshakeRefused("auth.device_invalid");
    if (device.tenantStatus === "suspended" || device.tenantStatus === "closed") {
      throw new HandshakeRefused("tenant.inactive");
    }
    const rate = await this.limiter.take(`api:tenant:${device.tenantId}`, RATE_RULES.tenantApi);
    if (!rate.allowed) throw new HandshakeRefused("rate.limited");
    socket.data = { tenantId: device.tenantId, deviceId: device.deviceId } satisfies SocketData;
  }

  /**
   * Closes this instance's connections and the adapter, but not the HTTP server: Nest closes that after
   * the shutdown hooks (Socket.IO's own close() would close it first).
   */
  async onApplicationShutdown(): Promise<void> {
    const io = this.io;
    if (!io) return;
    io.local.disconnectSockets(true);
    io.engine.close();
    io.of("/").adapter.close();
    await this.sub?.quit().catch(() => undefined);
  }
}
