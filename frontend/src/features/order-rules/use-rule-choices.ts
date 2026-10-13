"use client";

import { useQuery } from "@tanstack/react-query";
import { usePrintAgents } from "@/features/shipping/print-target";
import { api, unwrap } from "@/lib/api/client";
import { useCan } from "@/lib/session";
import type { Names } from "./order-rules-meta";

/** Stores, warehouses, and tags by id, for the rules' sentences and the editor's choices. */
export function useRuleChoices() {
  const can = useCan();
  const stores = useQuery({ queryKey: ["stores"], queryFn: () => unwrap(api.GET("/v1/stores")), staleTime: 60_000 });
  const warehouses = useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 5 * 60_000,
  });
  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: () => unwrap(api.GET("/v1/tags")),
    enabled: can("order:read"),
    staleTime: 60_000,
  });
  // only who may print reads the agents; a printing rule then names its agent
  const agents = usePrintAgents();
  const storeById = new Map((stores.data?.items ?? []).map((s) => [s.id, s]));
  const agentById = new Map((agents.data?.items ?? []).map((a) => [a.id, a]));
  const warehouseById = new Map((warehouses.data?.items ?? []).map((w) => [w.id, w]));
  const tagById = new Map((tags.data?.items ?? []).map((t) => [t.id, t]));
  const names: Names = {
    store: (id) => storeById.get(id)?.name,
    warehouse: (id) => warehouseById.get(id)?.name,
    tag: (id) => tagById.get(id)?.name,
    agent: (id) => agentById.get(id)?.name,
  };
  return {
    names,
    // rules act on marketplace orders only; disconnected stores take none
    stores: (stores.data?.items ?? []).filter((s) => s.channel !== "manual" && s.status !== "disconnected"),
    warehouses: warehouses.data?.items ?? [],
    tags: tags.data?.items ?? [],
    agents: agents.data?.items ?? [],
    pending: stores.isPending || warehouses.isPending,
  };
}
