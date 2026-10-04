"use client";

import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api/client";
import type { Store } from "./store-meta";

/**
 * The caller's stores (`GET /v1/stores`, the same cache as Toko Terhubung). Screens use it to know which
 * stores are still read-only (parallel mode): the api refuses seller actions on their orders and returns
 * (`store.read_only`), so those actions are not offered.
 */
export function useStores() {
  const stores = useQuery({ queryKey: ["stores"], queryFn: () => unwrap(api.GET("/v1/stores")), staleTime: 60_000 });
  const byId = new Map((stores.data?.items ?? []).map((s) => [s.id, s]));
  return {
    byId,
    /** A marketplace store still in parallel mode; manual sales channels are always live. */
    readOnly: (storeId: string | null | undefined): Store | null => {
      const s = storeId ? byId.get(storeId) : undefined;
      return s && s.channel !== "manual" && s.syncMode === "read_only" ? s : null;
    },
  };
}
