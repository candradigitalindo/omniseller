"use client";

import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/common/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUrlParams } from "@/hooks/use-url-params";
import { useCan } from "@/lib/session";
import { TABS } from "./courier-hours-meta";
import { CutoffsTab } from "./cutoffs-tab";
import { HolidaysTab } from "./holidays-tab";
import { HoursTab } from "./hours-tab";

/**
 * L43 Kurir & Jam Operasional (PRD FR-CMP-05, 06; backend doc 8.31): when couriers collect at each
 * warehouse, the days they do not, and when the business works. From them every order to ship gets the
 * last pickup it can still make.
 */
export function CourierHoursView() {
  const t = useTranslations("courierHours");
  const can = useCan();
  const { params, set } = useUrlParams();
  if (!can("settings:warehouse")) return <PageHeader title={t("title")} description={t("noAccess")} />;
  const tab = TABS.find((x) => x === params.get("tab")) ?? "cutoff";
  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <Tabs value={tab} onValueChange={(v) => set({ tab: v === "cutoff" ? null : v })}>
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
        <TabsContent value="cutoff">
          <CutoffsTab />
        </TabsContent>
        <TabsContent value="libur">
          <HolidaysTab />
        </TabsContent>
        <TabsContent value="jam">
          <HoursTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
