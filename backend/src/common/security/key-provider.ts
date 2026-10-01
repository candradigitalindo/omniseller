import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";

/**
 * Wraps and unwraps tenant data encryption keys (technology doc 19.3, envelope encryption). The DEK
 * encrypts marketplace tokens; the key provider only ever sees DEKs, never tokens. Every wrap is bound
 * to its tenant (KMS encryption context, GCM additional data locally), so a wrapped DEK copied to
 * another tenant's row does not unwrap.
 */
export interface KeyProvider {
  readonly provider: "local" | "aws_kms";
  /** Identifies the wrapping key; stored with the wrapped DEK. */
  readonly keyRef: string;
  generateDataKey(tenantId: string): Promise<{ plaintext: Buffer; wrapped: Buffer }>;
  unwrap(wrapped: Buffer, tenantId: string, keyRef: string): Promise<Buffer>;
}

const FORMAT_V1 = 1;

/** version(1) + nonce(12) + ciphertext + tag(16), AES-256-GCM. Same layout as encrypted tokens. */
export function sealAesGcm(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_V1]), nonce, ct, cipher.getAuthTag()]);
}

export function openAesGcm(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < 1 + 12 + 16 || sealed[0] !== FORMAT_V1) throw new Error("unsupported ciphertext format");
  const nonce = sealed.subarray(1, 13);
  const tag = sealed.subarray(sealed.length - 16);
  const ct = sealed.subarray(13, sealed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Local and test only (the environment schema refuses it elsewhere): DEKs are wrapped with a 32-byte
 * master key from TOKEN_LOCAL_MASTER_KEY. The key ref is a fingerprint, so changing the master key
 * makes old rows fail loudly instead of decrypting to garbage.
 */
export class LocalKeyProvider implements KeyProvider {
  readonly provider = "local" as const;
  readonly keyRef: string;
  private readonly master: Buffer;

  constructor(masterKeyBase64: string) {
    this.master = Buffer.from(masterKeyBase64, "base64");
    if (this.master.length !== 32) throw new Error("TOKEN_LOCAL_MASTER_KEY must be 32 bytes (base64)");
    this.keyRef = `local:${createHash("sha256").update(this.master).digest("hex").slice(0, 16)}`;
  }

  async generateDataKey(tenantId: string) {
    const plaintext = randomBytes(32);
    return { plaintext, wrapped: sealAesGcm(this.master, plaintext, `tenant_key:${tenantId}`) };
  }

  async unwrap(wrapped: Buffer, tenantId: string, keyRef: string): Promise<Buffer> {
    if (keyRef !== this.keyRef) throw new Error(`tenant key was wrapped by ${keyRef}, this process has ${this.keyRef}`);
    return openAesGcm(this.master, wrapped, `tenant_key:${tenantId}`);
  }
}

/** Staging and production: GenerateDataKey / Decrypt with the tenant id as encryption context. */
export class AwsKmsKeyProvider implements KeyProvider {
  readonly provider = "aws_kms" as const;

  constructor(
    readonly keyRef: string,
    private readonly kms: Pick<KMSClient, "send">,
  ) {}

  static create(keyId: string, region: string): AwsKmsKeyProvider {
    return new AwsKmsKeyProvider(keyId, new KMSClient({ region }));
  }

  async generateDataKey(tenantId: string) {
    const out = await this.kms.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyRef,
        KeySpec: "AES_256",
        EncryptionContext: { tenant_id: tenantId },
      }),
    );
    if (!out.Plaintext || !out.CiphertextBlob) throw new Error("KMS GenerateDataKey returned no key");
    return { plaintext: Buffer.from(out.Plaintext), wrapped: Buffer.from(out.CiphertextBlob) };
  }

  async unwrap(wrapped: Buffer, tenantId: string, keyRef: string): Promise<Buffer> {
    const out = await this.kms.send(
      new DecryptCommand({ CiphertextBlob: wrapped, KeyId: keyRef, EncryptionContext: { tenant_id: tenantId } }),
    );
    if (!out.Plaintext) throw new Error("KMS Decrypt returned no key");
    return Buffer.from(out.Plaintext);
  }
}
