import { hkdfSync } from "node:crypto";
import type { Redis } from "ioredis";
import { openAesGcm, sealAesGcm } from "../../common/security/key-provider";
import { hashToken, looksLikeSecretToken, newSecretToken } from "../../common/security/tokens";
import { authorizationInvalid } from "./channel.errors";

/** This is a pre-login handoff, never proof of a shop's identity or a grant to a tenant. */
export const INSTALLATION_TTL_SECONDS = 10 * 60;
const CLAIM_TTL_SECONDS = 45 * 60;
const PREFIX = "store-install:tiktokshop:";

export interface InstallationReview {
  awaitingShopSelection: boolean;
  shops: { externalShopId: string; name: string; region: string }[];
  selectedShopIds: string[];
}

interface Receipt {
  sealedCode?: string;
  codeHash: string;
  expiresAt: number;
}

/** A session-bound confirmation atomically claims a code globally, including duplicate captures. */
const CLAIM = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return false end
local previous = redis.call('GET', KEYS[3])
if previous then
  local claim = cjson.decode(previous)
  if claim.owner ~= ARGV[2] then return false end
  return claim.authorizationId
end
redis.call('SET', KEYS[3], cjson.encode({owner=ARGV[2],authorizationId=ARGV[3]}), 'EX', ARGV[4])
return ARGV[3]
`;

export class StoreInstallationStore {
  private readonly key: Buffer;

  constructor(
    private readonly redis: Redis,
    apiKeyBase64: string,
  ) {
    const key = Buffer.from(apiKeyBase64, "base64");
    if (key.length !== 32) throw new Error("Installation handoff requires a 32-byte API key");
    // Domain separation from TOTP: no marketplace token encryption key is loaded in the API.
    this.key = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "omniseller seller install code", 32));
  }

  private receiptKey(token: string): string {
    return `${PREFIX}receipt:${hashToken(token)}`;
  }

  private challengeKey(token: string, session: string): string {
    return `${this.receiptKey(token)}:challenge:${hashToken(session)}`;
  }

  private async receipt(token: string): Promise<Receipt> {
    if (!looksLikeSecretToken(token)) throw authorizationInvalid();
    const value = await this.redis.get(this.receiptKey(token));
    if (!value) throw authorizationInvalid();
    const receipt = JSON.parse(value) as Receipt;
    if (receipt.expiresAt <= Date.now()) throw authorizationInvalid();
    return receipt;
  }

  async capture(code: string): Promise<{ token: string; expiresAt: Date }> {
    const token = newSecretToken();
    const expiresAt = new Date(Date.now() + INSTALLATION_TTL_SECONDS * 1000);
    const receipt: Receipt = {
      sealedCode: sealAesGcm(this.key, Buffer.from(code), this.receiptKey(token)).toString("base64"),
      codeHash: hashToken(code),
      expiresAt: expiresAt.getTime(),
    };
    await this.redis.set(this.receiptKey(token), JSON.stringify(receipt), "EX", INSTALLATION_TTL_SECONDS);
    return { token, expiresAt };
  }

  async challenge(token: string, session: string): Promise<{ confirmationToken: string; expiresAt: Date }> {
    const receipt = await this.receipt(token);
    const confirmationToken = newSecretToken();
    const ttl = Math.max(1, Math.ceil((receipt.expiresAt - Date.now()) / 1000));
    await this.redis.set(this.challengeKey(token, session), hashToken(confirmationToken), "EX", ttl);
    return { confirmationToken, expiresAt: new Date(receipt.expiresAt) };
  }

  async claim(input: {
    token: string;
    session: string;
    confirmationToken: string;
    tenantId: string;
    userId: string;
    authorizationId: string;
  }): Promise<{ authorizationId: string; code?: string; expiresAt: Date }> {
    const receipt = await this.receipt(input.token);
    if (!looksLikeSecretToken(input.confirmationToken)) throw authorizationInvalid();
    const authorizationId = await this.redis.eval(
      CLAIM,
      3,
      this.receiptKey(input.token),
      this.challengeKey(input.token, input.session),
      `${PREFIX}code:${receipt.codeHash}`,
      hashToken(input.confirmationToken),
      hashToken(`${input.tenantId}:${input.userId}:${input.session}`),
      input.authorizationId,
      CLAIM_TTL_SECONDS,
    );
    if (typeof authorizationId !== "string") throw authorizationInvalid();
    return {
      authorizationId,
      ...(receipt.sealedCode
        ? {
            code: openAesGcm(
              this.key,
              Buffer.from(receipt.sealedCode, "base64"),
              this.receiptKey(input.token),
            ).toString(),
          }
        : {}),
      expiresAt: new Date(receipt.expiresAt),
    };
  }

  /** Keep only the idempotency receipt for its original TTL, never extend the code's lifetime. */
  async clearCode(token: string): Promise<void> {
    const key = this.receiptKey(token);
    await this.redis.eval(
      `local value=redis.call('GET',KEYS[1]); if not value then return end
       local receipt=cjson.decode(value); receipt.sealedCode=nil
       redis.call('SET',KEYS[1],cjson.encode(receipt),'KEEPTTL')`,
      1,
      key,
    );
  }
}
