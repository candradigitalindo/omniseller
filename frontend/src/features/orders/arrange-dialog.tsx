"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export type ArrangeMethod = "pickup" | "dropoff";

/** "Atur kirim": pickup by the courier or drop-off at a courier point, for one or many orders (backend 8.15). */
export function ArrangeDialog({
  orderIds,
  busy,
  onClose,
  onConfirm,
}: {
  orderIds: string[] | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (method: ArrangeMethod) => void;
}) {
  const t = useTranslations("orders");
  const tCommon = useTranslations("common");
  const [method, setMethod] = useState<ArrangeMethod>("pickup");
  const count = orderIds?.length ?? 0;
  return (
    <Dialog open={orderIds !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("arrangeTitle", { count })}</DialogTitle>
          <DialogDescription>{t("arrangeBody")}</DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={method}
          onValueChange={(v) => setMethod(v === "dropoff" ? "dropoff" : "pickup")}
          className="gap-3"
        >
          {(["pickup", "dropoff"] as const).map((m) => (
            <div key={m} className="flex items-start gap-3 rounded-lg border p-3">
              <RadioGroupItem value={m} id={`arrange-${m}`} className="mt-0.5" />
              <Label htmlFor={`arrange-${m}`} className="grid gap-0.5 font-normal">
                <span className="font-medium text-text-900">{t(m)}</span>
                <span className="text-[13px] text-text-500">{t(`${m}Hint`)}</span>
              </Label>
            </div>
          ))}
        </RadioGroup>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button loading={busy} onClick={() => onConfirm(method)}>
            {t("arrangeConfirm", { count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
