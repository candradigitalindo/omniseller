import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { FulfillmentRepository } from "./fulfillment.repository";
import { composeLabels, sampleMarketplaceLabel } from "./pdf";
import { DEFAULT_LABEL_TEMPLATE, type LabelTemplateOptions, templateStrip } from "./shipping-plan";

/**
 * The custom label template of a business (PRD FR-SHP-16, UI L42, backend doc 8.22): what is added under
 * marketplace labels when the seller prints with "Kustom". One per business; without one, the defaults.
 */
@Injectable()
export class LabelTemplateService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(FulfillmentRepository) private readonly repo: FulfillmentRepository,
  ) {}

  get(ctx: RequestContext): Promise<LabelTemplateOptions> {
    return withTenantTx(this.db, ctx, (tx) => this.optionsIn(tx));
  }

  async optionsIn(tx: Tx): Promise<LabelTemplateOptions> {
    const r = await this.repo.labelTemplate(tx);
    if (!r) return DEFAULT_LABEL_TEMPLATE;
    return {
      showSku: r.showSku,
      showVariant: r.showVariant,
      showBin: r.showBin,
      showBuyerNote: r.showBuyerNote,
      showTags: r.showTags,
    };
  }

  async set(ctx: RequestContext, patch: Partial<LabelTemplateOptions>): Promise<LabelTemplateOptions> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const next = { ...(await this.optionsIn(tx)), ...patch };
      await this.repo.saveLabelTemplate(tx, { id: newId(), tenantId: ctx.tenantId, ...next });
      return next;
    });
  }

  /** "Cetak percobaan" (L42): a stand-in marketplace label with the template under it. */
  async preview(ctx: RequestContext, format: "thermal" | "a4"): Promise<Uint8Array> {
    const options = await this.get(ctx);
    const strip = templateStrip(options, {
      number: "CONTOH-0001",
      note: "Tolong dibungkus rapi",
      tags: ["Prioritas"],
      lines: [
        { qty: 2, sku: "KAOS-HTM-L", name: "Kaos Polos", variant: "Hitam, L", bin: "A-01-03" },
        { qty: 1, sku: "TOPI-NAVY", name: "Topi Baseball", variant: null, bin: "B-12" },
      ],
    });
    return (await composeLabels([{ pdf: await sampleMarketplaceLabel(), strip }], format)).pdf;
  }
}
