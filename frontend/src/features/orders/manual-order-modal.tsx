"use client";

import { useRouter } from "next/navigation";
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
import { ManualOrderForm } from "./manual-order-form";

export function ManualOrderModal() {
  const t = useTranslations("manualOrder");
  const common = useTranslations("common");
  const router = useRouter();
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) {
            if (dirty) setConfirm(true);
            else router.push("/pesanan");
          }
        }}
      >
        <DialogContent
          className="flex w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle asChild>
              <h1>{t("title")}</h1>
            </DialogTitle>
            <DialogDescription>{t("modalDescription")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pt-3 sm:px-5">
            <ManualOrderForm compact onDirtyChange={setDirty} />
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("discardTitle")}</DialogTitle>
            <DialogDescription>{t("discardBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {common("back")}
            </Button>
            <Button variant="destructive" onClick={() => router.push("/pesanan")}>
              {t("discardConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
