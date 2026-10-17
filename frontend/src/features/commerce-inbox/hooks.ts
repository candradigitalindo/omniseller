"use client";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api/client";
import { pending } from "./contracts";

export function useInboxReceipt(id: string | undefined, accessKey: string) {
  return useQuery({
    queryKey: ["commerce-inbox", "receipt", id, accessKey],
    queryFn: () => unwrap(api.GET("/v1/commerce-inbox/requests/{id}", { params: { path: { id: id! } } })),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: (query) => (pending(query.state.data?.status) ? 1500 : false),
  });
}
export function useInboxPage(
  kind: "conversations" | "messages",
  principalId: string | undefined,
  conversationId: string | undefined,
  cursor: string | undefined,
  refresh: number,
  accessKey: string,
) {
  const request = useQuery({
    queryKey: ["commerce-inbox", kind, principalId, conversationId, cursor, refresh, accessKey],
    queryFn: () =>
      kind === "conversations"
        ? unwrap(
            api.POST("/v1/commerce-inbox/conversations/search", {
              body: { principalId: principalId!, ...(cursor ? { cursor } : {}) },
              params: { header: { "Idempotency-Key": crypto.randomUUID() } },
            }),
          )
        : unwrap(
            api.POST("/v1/commerce-inbox/messages/search", {
              body: { principalId: principalId!, conversationId: conversationId!, ...(cursor ? { cursor } : {}) },
              params: { header: { "Idempotency-Key": crypto.randomUUID() } },
            }),
          ),
    enabled: Boolean(principalId && (kind === "conversations" || conversationId)),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const receipt = useInboxReceipt(request.data?.id, accessKey);
  return {
    data: receipt.data,
    error: request.error ?? receipt.error,
    loading: request.isPending || receipt.isPending || pending(receipt.data?.status),
  };
}
