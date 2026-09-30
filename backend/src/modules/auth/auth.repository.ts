import { Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { passwordResetToken } from "../../db/schema";

/** Tables owned by the auth module: password_reset_token (sessions live in Redis). */
@Injectable()
export class AuthRepository {
  async insertResetToken(tx: Tx, row: typeof passwordResetToken.$inferInsert): Promise<void> {
    await tx.insert(passwordResetToken).values(row);
  }

  async lockResetToken(tx: Tx, id: string) {
    const [row] = await tx
      .select({
        id: passwordResetToken.id,
        userId: passwordResetToken.userId,
        expiresAt: passwordResetToken.expiresAt,
        usedAt: passwordResetToken.usedAt,
      })
      .from(passwordResetToken)
      .where(eq(passwordResetToken.id, id))
      .for("update");
    return row;
  }

  /** Marks every unused token of the user as used, so one reset invalidates all outstanding links. */
  async consumeResetTokens(tx: Tx, userId: string): Promise<void> {
    await tx
      .update(passwordResetToken)
      .set({ usedAt: new Date(), tokenHash: null })
      .where(and(eq(passwordResetToken.userId, userId), isNull(passwordResetToken.usedAt)));
  }
}
