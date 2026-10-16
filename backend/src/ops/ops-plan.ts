import { parseArgs } from "node:util";
import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { isQueueName } from "../jobs/queues";

export const COMMANDS = [
  "webhook:replay",
  "stock:push",
  "partition:maintain",
  "crypto:rotate-dek",
  "tenant:purge",
  "jobs:dlq",
  "jobs:retry",
] as const;
export type CommandName = (typeof COMMANDS)[number];
export type OpsCommand = {
  name: CommandName;
  dryRun: boolean;
  tenantId?: string;
  id?: string;
  source?: string;
  since?: Date;
  variantId?: string;
  warehouseId?: string;
  queue?: string;
  all: boolean;
  force: boolean;
  limit: number;
};

const allowed: Record<CommandName, string[]> = {
  "webhook:replay": ["tenant", "id", "source", "since", "force", "limit"],
  "stock:push": ["tenant", "variant", "warehouse"],
  "partition:maintain": [],
  "crypto:rotate-dek": ["tenant"],
  "tenant:purge": ["tenant"],
  "jobs:dlq": ["queue", "limit"],
  "jobs:retry": ["queue", "id", "all", "limit"],
};

/** Strict before opening any connection: misspelled or irrelevant options never run a command. */
export function parseOpsCommand(args: string[]): OpsCommand {
  const [name, ...rest] = args;
  if (!COMMANDS.includes(name as CommandName)) throw new Error("unknown operational command");
  const command = name as CommandName;
  const options = Object.fromEntries(
    [...allowed[command], "dry-run"].map((key) => [
      key,
      {
        type: ["force", "all", "dry-run"].includes(key) ? ("boolean" as const) : ("string" as const),
      },
    ]),
  );
  const { values } = parseArgs({ args: rest, options, strict: true, allowPositionals: false });
  const value = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : undefined);
  const required = (key: string) => {
    const v = value(key);
    if (!v) throw new Error(`--${key} is required`);
    return v;
  };
  const id = (key: string) => ulidSchema.parse(required(key));
  const result: OpsCommand = {
    name: command,
    dryRun: values["dry-run"] === true,
    all: values.all === true,
    force: values.force === true,
    limit: Number(value("limit") ?? 100),
  };
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 1000)
    throw new Error("--limit must be 1..1000");
  if (allowed[command].includes("tenant")) result.tenantId = id("tenant");
  if (command === "stock:push") {
    result.variantId = id("variant");
    result.warehouseId = id("warehouse");
  }
  if (command.startsWith("jobs:")) {
    result.queue = required("queue");
    if (!isQueueName(result.queue)) throw new Error("unknown queue");
    result.id = value("id");
    if (command === "jobs:retry" && Boolean(result.id) === result.all) throw new Error("choose --id or --all");
    if (result.id && (result.id.length > 500 || [...result.id].some((char) => char.charCodeAt(0) < 32)))
      throw new Error("invalid job id");
  }
  if (command === "webhook:replay") {
    result.id = value("id");
    result.source = value("source");
    if (result.id) {
      ulidSchema.parse(result.id);
      if (result.source || value("since")) throw new Error("choose --id or --source with --since");
    } else {
      if (!["shopee", "tiktokshop"].includes(required("source"))) throw new Error("unknown webhook source");
      const since = required("since");
      const withSeconds = since.replace(/(T\d\d:\d\d)(Z|[+-]\d\d:\d\d)$/, "$1:00$2");
      if (
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(since) ||
        !z.iso.datetime({ offset: true }).safeParse(withSeconds).success
      )
        throw new Error("--since must include a UTC offset");
      result.since = new Date(since);
    }
  }
  return result;
}

export function guardOps(command: OpsCommand, env: Record<string, string | undefined>): void {
  if (!["local", "test", "staging", "production"].includes(env.NODE_ENV ?? "")) throw new Error("NODE_ENV is required");
  if (command.name !== "jobs:dlq" && !command.dryRun && env.NODE_ENV === "production" && env.OPS_CONFIRM !== "1") {
    throw new Error("production mutations require OPS_CONFIRM=1; inspect with --dry-run first");
  }
}
