import { newId } from "@omniseller/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { tenantKey } from "../../db/schema";
import { type KeyProvider, openAesGcm, sealAesGcm } from "./key-provider";

const DEK_CACHE_MS = 10 * 60 * 1000;

interface CachedKey {
  dek: Buffer;
  version: number;
  until: number;
}

/**
 * Encrypts secrets of a tenant with that tenant's DEK (technology doc 19.3). Used by the worker only;
 * the api role has no access to tenant_key at all.
 *
 * Ciphertexts are version(1) + nonce(12) + ciphertext + tag(16) with AES-256-GCM, and bound to a
 * purpose string (for example `store:<id>:access`): a token copied onto another store's row fails to
 * decrypt. Unwrapped DEKs are cached for 10 minutes per process.
 */
export class TokenVault {
  private readonly cache = new Map<string, CachedKey>();

  constructor(private readonly keys: KeyProvider) {}

  async seal(
    tx: Tx,
    tenantId: string,
    plaintext: string,
    purpose: string,
  ): Promise<{ data: Buffer; dekVersion: number }> {
    const key = await this.activeKey(tx, tenantId);
    return {
      data: sealAesGcm(key.dek, Buffer.from(plaintext, "utf8"), `${tenantId}:${purpose}`),
      dekVersion: key.version,
    };
  }

  async open(tx: Tx, tenantId: string, data: Buffer, dekVersion: number, purpose: string): Promise<string> {
    const key = await this.keyByVersion(tx, tenantId, dekVersion);
    return openAesGcm(key.dek, data, `${tenantId}:${purpose}`).toString("utf8");
  }

  private cached(tenantId: string, version: number | "active"): CachedKey | undefined {
    const hit = this.cache.get(`${tenantId}:${version}`);
    if (hit && hit.until > Date.now()) return hit;
    return undefined;
  }

  private remember(tenantId: string, key: Omit<CachedKey, "until">, active: boolean): CachedKey {
    const entry = { ...key, until: Date.now() + DEK_CACHE_MS };
    this.cache.set(`${tenantId}:${key.version}`, entry);
    if (active) this.cache.set(`${tenantId}:active`, entry);
    return entry;
  }

  private async activeKey(tx: Tx, tenantId: string): Promise<CachedKey> {
    const hit = this.cached(tenantId, "active");
    if (hit) return hit;
    const [row] = await tx
      .select()
      .from(tenantKey)
      .where(and(eq(tenantKey.tenantId, tenantId), isNull(tenantKey.retiredAt)))
      .limit(1);
    if (row) {
      const dek = await this.keys.unwrap(row.wrappedDek, tenantId, row.keyRef);
      return this.remember(tenantId, { dek, version: row.version }, true);
    }
    return this.createKey(tx, tenantId);
  }

  /** First secret of a tenant: generate and store its DEK. Two workers racing both succeed; one row wins. */
  private async createKey(tx: Tx, tenantId: string): Promise<CachedKey> {
    const [latest] = await tx
      .select({ version: tenantKey.version })
      .from(tenantKey)
      .where(eq(tenantKey.tenantId, tenantId))
      .orderBy(desc(tenantKey.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    const generated = await this.keys.generateDataKey(tenantId);
    try {
      await tx.transaction(async (sp) => {
        await sp.insert(tenantKey).values({
          id: newId(),
          tenantId,
          version,
          provider: this.keys.provider,
          keyRef: this.keys.keyRef,
          wrappedDek: generated.wrapped,
        });
      });
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      this.cache.delete(`${tenantId}:active`);
      const [winner] = await tx
        .select()
        .from(tenantKey)
        .where(and(eq(tenantKey.tenantId, tenantId), isNull(tenantKey.retiredAt)))
        .limit(1);
      if (!winner) throw err;
      const dek = await this.keys.unwrap(winner.wrappedDek, tenantId, winner.keyRef);
      return this.remember(tenantId, { dek, version: winner.version }, true);
    }
    return this.remember(tenantId, { dek: generated.plaintext, version }, true);
  }

  private async keyByVersion(tx: Tx, tenantId: string, version: number): Promise<CachedKey> {
    const hit = this.cached(tenantId, version);
    if (hit) return hit;
    const [row] = await tx
      .select()
      .from(tenantKey)
      .where(and(eq(tenantKey.tenantId, tenantId), eq(tenantKey.version, version)))
      .limit(1);
    if (!row) throw new Error(`tenant key version ${version} not found`);
    const dek = await this.keys.unwrap(row.wrappedDek, tenantId, row.keyRef);
    return this.remember(tenantId, { dek, version }, row.retiredAt === null);
  }
}
