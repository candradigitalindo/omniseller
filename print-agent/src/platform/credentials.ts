import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { AgentError } from "../core/types";

export type Credentials = { origin: string; token: string; deviceId: string };
export interface SecretStorage {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
export class CredentialStore {
  constructor(
    private readonly path: string,
    private readonly secure: SecretStorage,
  ) {}
  async save(value: Credentials): Promise<void> {
    if (!this.secure.available()) throw new AgentError("storage");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const data = this.secure.encrypt(JSON.stringify(value));
    await writeFile(`${this.path}.tmp`, data, { mode: 0o600 });
    await rename(`${this.path}.tmp`, this.path);
  }
  async load(): Promise<Credentials | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AgentError("storage");
    }
    if (!this.secure.available()) throw new AgentError("storage");
    try {
      return z
        .object({ origin: z.string(), token: z.string().regex(/^[\w-]{43}$/), deviceId: z.string().length(26) })
        .parse(JSON.parse(this.secure.decrypt(encrypted)));
    } catch {
      throw new AgentError("storage");
    }
  }
  async clear(): Promise<void> {
    await rm(this.path, { force: true });
    await rm(`${this.path}.tmp`, { force: true });
  }
}
