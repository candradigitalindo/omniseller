import type { components } from "../api/schema";

export type RemoteJob = components["schemas"]["AgentJobListDto_Output"]["items"][number];
export type AgentSelf = components["schemas"]["AgentSelfDto_Output"];
export type Printer = { name: string; isDefault: boolean; ready?: boolean };
export type Preferences = { labelPrinter: string | null; documentPrinter: string | null; name?: string };
export type ErrorCode =
  | "connection"
  | "auth"
  | "request_rejected"
  | "printer_missing"
  | "printer_busy"
  | "pdf_invalid"
  | "pdf_too_large"
  | "interrupted"
  | "storage"
  | "unknown";
export class AgentError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status = 0,
  ) {
    super(code);
  }
}
export type LocalState = "queued" | "printing" | "printed" | "failed" | "uncertain" | "cancelled";
// Titles and document bytes are deliberately absent: a title may contain buyer information.
export type LocalJob = Pick<RemoteJob, "id" | "attempt" | "kind" | "printer" | "copies" | "createdAt"> & {
  state: LocalState;
  reported: number;
  retries: number;
  dueAt: number;
  error: ErrorCode | null;
};
export interface PrinterDriver {
  list(): Promise<Printer[]>;
  print(file: string, printer: string, copies: number): Promise<void>;
}
export interface AgentApi {
  testPrint(): Promise<void>;
  retry(id: string): Promise<void>;
  status(printers: Printer[], preferences?: Preferences): Promise<AgentSelf>;
  pending(): Promise<RemoteJob[]>;
  download(job: Pick<RemoteJob, "id" | "attempt">, signal?: AbortSignal): Promise<string>;
  result(job: Pick<RemoteJob, "id" | "attempt">, status: "printed" | "failed", error?: string): Promise<void>;
}
export interface AgentSnapshot {
  paired: boolean;
  origin: string;
  name: string;
  connected: boolean;
  paused: boolean;
  error: ErrorCode | null;
  printers: Printer[];
  preferences: Preferences;
  jobs: LocalJob[];
  version: string;
  update: string;
}
