import { createHash } from "node:crypto";
import { newId } from "@omniseller/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { tenantKey } from "../../db/schema";
import { type KeyProvider, openAesGcm, sealAesGcm } from "./key-provider";

const DEK_CACHE_MS = 10 * 60 * 1000;
interface CachedKey {
  dek: Buffer;
  version: number;
  until: number;
}

/** All token writers and rotations take this transaction lock before choosing an active DEK. */
export async function lockTenantKeys(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tenant_dek:${tenantId}`}, 0))`);
}

/** Worker-only AES-256-GCM envelope encryption, bound to the tenant, store, and token field. */
export class TokenVault {
  private readonly cache = new Map<string, CachedKey>();
  constructor(private readonly keys: KeyProvider) {}

  async seal(
    tx: Tx,
    tenantId: string,
    plaintext: string,
    purpose: string,
  ): Promise<{ data: Buffer; dekVersion: number }> {
    await lockTenantKeys(tx, tenantId);
    // Read the active version every time: another process may have committed a rotation.
    const [row] = await tx
      .select()
      .from(tenantKey)
      .where(and(eq(tenantKey.tenantId, tenantId), isNull(tenantKey.retiredAt)))
      .limit(1);
    const key = row ? await this.unwrap(tenantId, row) : await this.createKey(tx, tenantId);
    return {
      data: sealAesGcm(key.dek, Buffer.from(plaintext, "utf8"), `${tenantId}:${purpose}`),
      dekVersion: key.version,
    };
  }

  async open(tx: Tx, tenantId: string, data: Buffer, dekVersion: number, purpose: string): Promise<string> {
    const [row] = await tx
      .select()
      .from(tenantKey)
      .where(and(eq(tenantKey.tenantId, tenantId), eq(tenantKey.version, dekVersion)))
      .limit(1);
    if (!row) throw new Error(`tenant key version ${dekVersion} not found`);
    const key = await this.unwrap(tenantId, row);
    return openAesGcm(key.dek, data, `${tenantId}:${purpose}`).toString("utf8");
  }

  /** A rotation occurrence uses its ULID as the key id: retries resume instead of rotating again. */
  async rotateIn(tx: Tx, tenantId: string, rotationId: string): Promise<number> {
    await lockTenantKeys(tx, tenantId);
    const [existing] = await tx
      .select({ version: tenantKey.version })
      .from(tenantKey)
      .where(and(eq(tenantKey.tenantId, tenantId), eq(tenantKey.id, rotationId)));
    if (existing) return existing.version;
    await tx
      .update(tenantKey)
      .set({ retiredAt: new Date() })
      .where(and(eq(tenantKey.tenantId, tenantId), isNull(tenantKey.retiredAt)));
    return (await this.createKey(tx, tenantId, rotationId)).version;
  }

  private async unwrap(tenantId: string, row: typeof tenantKey.$inferSelect): Promise<CachedKey> {
    // Include the wrapped bytes: an uncommitted key may have rolled back and its version been reused.
    const cacheKey = `${tenantId}:${row.version}:${createHash("sha256").update(row.wrappedDek).digest("hex")}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.until > Date.now()) return hit;
    for (const [key, entry] of this.cache) if (entry.until <= Date.now()) this.cache.delete(key);
    const entry = {
      dek: await this.keys.unwrap(row.wrappedDek, tenantId, row.keyRef),
      version: row.version,
      until: Date.now() + DEK_CACHE_MS,
    };
    this.cache.set(cacheKey, entry);
    return entry;
  }

  private async createKey(tx: Tx, tenantId: string, id = newId()): Promise<CachedKey> {
    const [latest] = await tx
      .select({ version: tenantKey.version })
      .from(tenantKey)
      .where(eq(tenantKey.tenantId, tenantId))
      .orderBy(desc(tenantKey.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    const generated = await this.keys.generateDataKey(tenantId);
    await tx.insert(tenantKey).values({
      id,
      tenantId,
      version,
      provider: this.keys.provider,
      keyRef: this.keys.keyRef,
      wrappedDek: generated.wrapped,
    });
    return { dek: generated.plaintext, version, until: Date.now() + DEK_CACHE_MS };
  }
}
