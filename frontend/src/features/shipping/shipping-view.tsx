"use client";

import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/common/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUrlParams } from "@/hooks/use-url-params";
import { type Permission, useCan } from "@/lib/session";
import { HandoverDesk } from "./handover-desk";
import { LabelPrinting } from "./label-printing";
import { PackStation } from "./pack-station";

const TABS = [
  { key: "kemas", permission: "shipment:pack" },
  { key: "label", permission: "shipment:print" },
  { key: "serah-terima", permission: "shipment:handover" },
] as const satisfies readonly { key: string; permission: Permission }[];

/**
 * Pengiriman (DOKUMEN-UI-UX 7.1): the warehouse's three stations in one place, each shown to who may use
 * it: packing by scan (L06), labels and the print queue (L07), and the courier handover (L08).
 */
export function ShippingView() {
  const t = useTranslations("shipping");
  const can = useCan();
  const { params, set } = useUrlParams();
  const tabs = TABS.filter((x) => can(x.permission));
  const tab = tabs.find((x) => x.key === params.get("tab"))?.key ?? tabs[0]?.key;
  if (!tab) return <PageHeader title={t("title")} description={t("noAccess")} />;
  return (
    <>
      <PageHeader title={t("title")} />
      <Tabs value={tab} onValueChange={(v) => set({ tab: v, manifest: null })}>
        <TabsList variant="line" className="mb-4 w-full justify-start overflow-x-auto border-b" aria-label={t("tabs")}>
          {tabs.map((x) => (
            <TabsTrigger key={x.key} value={x.key} className="flex-none px-3 text-[15px]">
              {t(`tab_${x.key}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="kemas">
          <PackStation />
        </TabsContent>
        <TabsContent value="label">
          <LabelPrinting />
        </TabsContent>
        <TabsContent value="serah-terima">
          <HandoverDesk />
        </TabsContent>
      </Tabs>
    </>
  );
}
