import type { AgentSnapshot, ErrorCode, Preferences } from "./core/types";
export type Action =
  | { type: "retry"; id: string }
  | { type: "pair"; origin: string; token: string }
  | { type: "refresh" | "test-print" }
  | { type: "pause"; paused: boolean }
  | { type: "printers"; preferences: Preferences }
  | { type: "resolve"; id: string; attempt: number; status: "printed" | "failed" }
  | { type: "unpair" }
  | { type: "update" }
  | { type: "quit" };
export type Reply = { ok: true } | { ok: false; error: ErrorCode };
export interface DesktopBridge {
  snapshot(): Promise<AgentSnapshot>;
  act(action: Action): Promise<Reply>;
  subscribe(listener: (state: AgentSnapshot) => void): () => void;
}
declare global {
  interface Window {
    printAgent: DesktopBridge;
  }
}
