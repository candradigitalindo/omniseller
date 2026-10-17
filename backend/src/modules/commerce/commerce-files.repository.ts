import { Injectable } from "@nestjs/common";
import { eq, gt } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { commerceFile } from "../../db/schema/commerce-files";
@Injectable()
export class CommerceFilesRepository {
  async get(tx: Tx, id: string) {
    return (await tx.select().from(commerceFile).where(eq(commerceFile.id, id)))[0];
  }
  async insert(tx: Tx, values: typeof commerceFile.$inferInsert) {
    await tx.insert(commerceFile).values(values);
  }
  page(tx: Tx, after: string | undefined, limit: number) {
    return tx
      .select()
      .from(commerceFile)
      .where(after ? gt(commerceFile.id, after) : undefined)
      .orderBy(commerceFile.id)
      .limit(limit);
  }
}
