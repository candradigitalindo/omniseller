"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";

type Results = { items: { id: string; ok: boolean; code?: string; message?: string }[] };

/**
 * Accept, pack, and arrange shipment for many orders at once. The api answers per order; the toast says
 * how many went through and, when some did not, why the first one failed (DOKUMEN-UI-UX 9, aksi massal).
 */
export function useOrderActions(onDone?: () => void) {
  const t = useTranslations("orders");
  const queryClient = useQueryClient();

  const report = (results: Results, done: (count: number) => string) => {
    const ok = results.items.filter((r) => r.ok).length;
    const failed = results.items.filter((r) => !r.ok);
    if (ok > 0) toast.success(done(ok));
    if (failed.length > 0) {
      toast.error(t("someFailed", { count: failed.length }), { description: failed[0]?.message ?? failed[0]?.code });
    }
    void queryClient.invalidateQueries({ queryKey: ["orders"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    onDone?.();
  };
  const fail = (error: unknown) => toast.error(errorMessage(error));

  const accept = useMutation({
    mutationFn: (orderIds: string[]) => unwrap(api.POST("/v1/orders/accept", { body: { orderIds } })),
    onSuccess: (r) => report(r, (n) => t("accepted", { count: n })),
    onError: fail,
  });
  const pack = useMutation({
    mutationFn: (orderIds: string[]) => unwrap(api.POST("/v1/orders/pack", { body: { orderIds } })),
    onSuccess: (r) => report(r, (n) => t("packed", { count: n })),
    onError: fail,
  });
  const arrange = useMutation({
    mutationFn: (input: { orderIds: string[]; method: "pickup" | "dropoff" }) =>
      unwrap(api.POST("/v1/shipments/arrange", { body: input })),
    onSuccess: (r) => report(r, (n) => t("arranged", { count: n })),
    onError: fail,
  });

  return { accept, pack, arrange, busy: accept.isPending || pack.isPending || arrange.isPending };
}
