import { logger } from "@omniseller/logging";
import { Emitter } from "@socket.io/redis-emitter";
import type { Redis } from "ioredis";
import type { PrintJobKind } from "../db/schema";

const log = logger.forModule("realtime");

export const REALTIME = Symbol("REALTIME");

/**
 * Pushes to connected clients (technology doc 7.3, backend doc 8.24). Socket.IO runs in the api process
 * (`RealtimeGateway`) with the Redis adapter; every process publishes through the Redis emitter on the
 * same channel, so an event reaches the client whichever api instance holds its connection. Delivery is
 * best effort: clients fetch what they missed over REST (print agents list their pending jobs).
 */
export interface Realtime {
  /** The pub/sub channel prefix; the gateway's adapter listens on the same one. */
  readonly channel: string;
  /** One print agent (room `device:<id>`). */
  toDevice<E extends keyof DeviceEvents>(deviceId: string, event: E, payload: DeviceEvents[E]): void;
  /** Closes the device's connections (it was revoked). */
  disconnectDevice(deviceId: string): void;
}

/** A job as the agent sees it, pushed and listed alike (`GET /v1/agent/print-jobs`). */
export interface AgentPrintJob {
  id: string;
  kind: PrintJobKind;
  title: string;
  /** The printer to use; null: the computer's default printer. */
  printer: string | null;
  copies: number;
  createdAt: string;
}

/** What a print agent receives. */
export interface DeviceEvents {
  /** A job is ready: the agent downloads `/v1/agent/print-jobs/{id}/file`, prints, and reports. */
  "print.job": AgentPrintJob;
  /** A job was cancelled before the agent reported it. */
  "print.cancelled": { id: string };
}

export const deviceRoom = (deviceId: string) => `device:${deviceId}`;

/** The pub/sub channel prefix of the adapter and the emitter; test runs keep theirs apart. */
export const realtimeKey = (prefix?: string) => (prefix ? `${prefix}:socket.io` : "socket.io");

/**
 * The emitter publishes without awaiting; a Redis outage must not become an unhandled rejection that
 * ends the process, so publish failures are logged and dropped (clients catch up over REST).
 */
function safePublisher(redis: Redis) {
  return {
    publish: (channel: string, message: Buffer | string) =>
      redis.publish(channel, message).catch((err: unknown) => {
        log.warn({ err }, "realtime publish failed");
        return 0;
      }),
  };
}

export class RedisRealtime implements Realtime {
  private readonly emitter: Emitter;

  constructor(
    redis: Redis,
    readonly channel: string,
  ) {
    this.emitter = new Emitter(safePublisher(redis), { key: channel });
  }

  toDevice<E extends keyof DeviceEvents>(deviceId: string, event: E, payload: DeviceEvents[E]): void {
    this.emitter.to(deviceRoom(deviceId)).emit(event, payload);
  }

  disconnectDevice(deviceId: string): void {
    this.emitter.in(deviceRoom(deviceId)).disconnectSockets(true);
  }
}
