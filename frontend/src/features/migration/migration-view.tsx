"use client";

import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/common/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUrlParams } from "@/hooks/use-url-params";
import { useCan } from "@/lib/session";
import { ImportTab } from "./import-panel";
import { ParallelTab } from "./parallel-panel";

const TABS = ["impor", "pindah"] as const;

/**
 * L46 Migrasi Data (DOKUMEN-UI-UX 14.8, backend 8.19): moving from another app without messing up the stock.
 * Steps 1 to 3 bring the products and their first stock in from the old app's export; steps 4 and 5 compare
 * both systems while OmniSeller only reads, then move the stores live.
 */
export function MigrationView() {
  const t = useTranslations("migration");
  const can = useCan();
  const { params, set } = useUrlParams();
  if (!can("settings:store")) return <PageHeader title={t("title")} description={t("noAccess")} />;
  const tab = TABS.find((x) => x === params.get("tab")) ?? "impor";
  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <Tabs value={tab} onValueChange={(v) => set({ tab: v === "impor" ? null : v, job: null })}>
        <TabsList
          variant="line"
          className="mb-4 w-full max-w-full justify-start overflow-x-auto border-b"
          aria-label={t("tabs")}
        >
          {TABS.map((x) => (
            <TabsTrigger key={x} value={x} className="flex-none px-3 text-[15px]">
              {t(`tab_${x}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="impor">
          <ImportTab />
        </TabsContent>
        <TabsContent value="pindah">
          <ParallelTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
