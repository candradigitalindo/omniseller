import { AsyncLocalStorage } from "node:async_hooks";
import { type CallRecord, type ConnectorError, isConnectorError } from "@omniseller/connector-core";

/**
 * Connector call recording (backend doc 8.6): every HTTP call a connector makes inside
 * `recordConnectorCalls` is appended, already redacted by the connector, to the given list, which the
 * sync log stores with the operation. Connectors are built with `connectorCallObserver`.
 */
const callScope = new AsyncLocalStorage<CallRecord[]>();

export function recordConnectorCalls<T>(into: CallRecord[], fn: () => Promise<T>): Promise<T> {
  return callScope.run(into, fn);
}

export const connectorCallObserver = (record: CallRecord): void => {
  callScope.getStore()?.push(record);
};

const KIND_MESSAGES: Record<ConnectorError["kind"], string> = {
  transient: "Marketplace sedang sibuk atau tidak bisa dihubungi. OmniSeller mencoba lagi otomatis.",
  auth_expired: "Token akses toko kedaluwarsa dan sedang diperbarui otomatis.",
  auth_revoked: "Izin toko dicabut atau sudah habis. Hubungkan ulang toko ini.",
  permanent: "Marketplace menolak permintaan ini.",
};

/**
 * Error code and a message a seller can act on (FR-INT-06: "pesan error yang mudah dipahami"). The
 * marketplace's own message is kept after the explanation for support.
 */
export function describeSyncError(err: unknown): { code: string; message: string } {
  if (isConnectorError(err)) {
    const detail = err.message.replace(/^[^:]+:\s*/, "");
    return {
      code: `${err.kind}.${err.code}`.slice(0, 120),
      message: `${KIND_MESSAGES[err.kind]} (${detail})`.slice(0, 1000),
    };
  }
  const code = (err as { code?: unknown })?.code;
  return {
    code: typeof code === "string" ? code.slice(0, 120) : "internal",
    message: "Terjadi kesalahan di OmniSeller. Tim kami sudah menerima laporannya.",
  };
}
