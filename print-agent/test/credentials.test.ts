import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CredentialStore, type SecretStorage } from "../src/platform/credentials";

test("credentials are encrypted atomically and have no plaintext fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omni-secrets-"));
  const path = join(directory, "credentials.enc");
  const key = randomBytes(32);
  const secure: SecretStorage = {
    available: () => true,
    encrypt(value) {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]);
    },
    decrypt(value) {
      const c = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      c.setAuthTag(value.subarray(-16));
      return Buffer.concat([c.update(value.subarray(12, -16)), c.final()]).toString();
    },
  };
  const value = { origin: "https://api.test", token: "A".repeat(43), deviceId: "01K6MQB3P30000000000000001" };
  try {
    const store = new CredentialStore(path, secure);
    assert.equal(await store.load(), null);
    await store.save(value);
    assert.deepEqual(await store.load(), value);
    assert.equal((await readFile(path)).includes(Buffer.from(value.token)), false);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    const unavailable = new CredentialStore(path, { ...secure, available: () => false });
    await assert.rejects(unavailable.save(value));
    await assert.rejects(unavailable.load());
    await writeFile(path, "corrupt");
    await assert.rejects(store.load());
    await store.clear();
    assert.equal(await store.load(), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
