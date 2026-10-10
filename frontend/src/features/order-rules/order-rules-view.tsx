"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CircleAlert, Pencil, Plus, Trash2, Zap } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, PageHeader } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatRupiah } from "@/lib/format";
import { useCan, useHasFeature, useSession } from "@/lib/session";
import { actionParts, conditionParts, moved, type Names, type OrderRule } from "./order-rules-meta";
import { RuleDialog } from "./rule-editor";
import { useRuleChoices } from "./use-rule-choices";

export const rulesQueryKey = ["order-rules"] as const;

/**
 * L55 Aturan Otomatis (PRD FR-ORD-19, backend doc 8.37), from plan Growth on: rules that process new
 * marketplace orders as they arrive, checked in the order shown, the first that matches acting once. For
 * whoever accepts orders (`order:accept`); a rule's actions need the permissions of their buttons too.
 */
export function OrderRulesView() {
  const t = useTranslations("orderRules");
  const can = useCan();
  const me = useSession();
  const featured = useHasFeature("auto_process");
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<OrderRule | "new" | null>(null);
  const [removing, setRemoving] = useState<OrderRule | null>(null);
  const allowed = can("order:accept");
  const rules = useQuery({
    queryKey: rulesQueryKey,
    queryFn: () => unwrap(api.GET("/v1/order-rules")),
    enabled: allowed,
  });
  const choices = useRuleChoices();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: rulesQueryKey });
  const failed = (e: unknown) => {
    toast.error(errorMessage(e));
    refresh();
  };

  const toggle = useMutation({
    mutationFn: (r: OrderRule) =>
      unwrap(
        api.PATCH("/v1/order-rules/{id}", {
          params: { path: { id: r.id } },
          body: { active: !r.active },
          headers: { "If-Match": `"${r.rowVersion}"` },
        }),
      ),
    onSuccess: (r) => {
      toast.success(r.active ? t("switchedOn", { name: r.name }) : t("switchedOff", { name: r.name }));
      refresh();
    },
    onError: failed,
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => unwrap(api.PUT("/v1/order-rules/priority", { body: { ids } })),
    onSuccess: (data) => queryClient.setQueryData(rulesQueryKey, data),
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (r: OrderRule) => unwrap(api.DELETE("/v1/order-rules/{id}", { params: { path: { id: r.id } } })),
    onSuccess: (_, r) => {
      setRemoving(null);
      toast.success(t("removed", { name: r.name }));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!allowed) return <PageHeader title={t("title")} description={t("noAccess")} />;
  const list = rules.data?.items ?? [];
  const locked = (
    <>
      {t("locked", { plan: me.plan.name })}
      {can("settings:billing") ? (
        <>
          {" "}
          <Link href="/langganan" className="font-medium text-primary hover:underline">
            {t("seePlans")}
          </Link>
        </>
      ) : null}
    </>
  );
  if (!featured && rules.isSuccess && list.length === 0) {
    return (
      <>
        <PageHeader title={t("title")} description={t("description")} />
        <Card>
          <CardHeader>
            <CardTitle>{t("lockedTitle")}</CardTitle>
            <CardDescription>{locked}</CardDescription>
          </CardHeader>
        </Card>
      </>
    );
  }

  const ids = list.map((r) => r.id);
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          featured ? (
            <Button onClick={() => setEditing("new")}>
              <Plus aria-hidden />
              {t("add")}
            </Button>
          ) : null
        }
      />

      {!featured ? (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-text-900"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p>
            {t("paused")} {locked}
          </p>
        </div>
      ) : null}

      {rules.isPending || choices.pending ? (
        <Skeleton className="h-48" />
      ) : rules.isError ? (
        <Card>
          <ErrorState error={rules.error} onRetry={() => rules.refetch()} />
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={Zap}
            title={t("emptyTitle")}
            body={t("emptyBody")}
            action={
              <Button onClick={() => setEditing("new")}>
                <Plus aria-hidden />
                {t("add")}
              </Button>
            }
          />
        </Card>
      ) : (
        <ol aria-label={t("listLabel")} className="grid gap-3">
          {list.map((r, i) => (
            <li key={r.id}>
              <RuleCard
                rule={r}
                index={i}
                count={list.length}
                names={choices.names}
                editable={featured}
                busy={reorder.isPending}
                onToggle={() => toggle.mutate(r)}
                onMove={(delta) => reorder.mutate(moved(ids, i, delta))}
                onEdit={() => setEditing(r)}
                onRemove={() => setRemoving(r)}
              />
            </li>
          ))}
        </ol>
      )}

      <p className="mt-4 text-[13px] text-text-500">{t("howItRuns")}</p>

      <RuleDialog rule={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      <Dialog open={removing !== null} onOpenChange={(v) => !v && setRemoving(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("removeTitle", { name: removing?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("removeBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() => removing && remove.mutate(removing)}
            >
              {t("remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RuleCard({
  rule,
  index,
  count,
  names,
  editable,
  busy,
  onToggle,
  onMove,
  onEdit,
  onRemove,
}: {
  rule: OrderRule;
  index: number;
  count: number;
  names: Names;
  editable: boolean;
  busy: boolean;
  onToggle: () => void;
  onMove: (delta: -1 | 1) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations("orderRules");
  // totals read as rupiah
  const money = (v: Record<string, string | number>) =>
    Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        (k === "min" || k === "max") && typeof x === "number" ? formatRupiah(x) : x,
      ]),
    );
  const when = conditionParts(rule.conditions, names).map((p) => t(p.key, money(p.values)));
  const then = actionParts(rule.actions, names).map((p) => t(p.key, p.values));
  return (
    <Card className={rule.active ? undefined : "bg-surface-2"}>
      <CardContent className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-100 text-sm font-semibold text-primary-700"
        >
          {index + 1}
        </span>
        <div className="grid min-w-0 flex-1 basis-64 gap-1.5">
          <h2 className="flex flex-wrap items-center gap-2 font-semibold text-text-900">
            <span className="sr-only">{t("position", { n: index + 1 })}</span>
            {rule.name}
            {rule.active ? null : (
              <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-text-500 ring-1 ring-border">
                {t("inactive")}
              </span>
            )}
          </h2>
          <p className="text-sm text-text-700">
            <span className="font-medium text-text-900">{t("when")}</span>{" "}
            {when.length > 0 ? when.join(" · ") : t("whenAny")}
          </p>
          <p className="text-sm text-text-700">
            <span className="font-medium text-text-900">{t("then")}</span> {then.join(" → ")}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {editable ? (
            <>
              <span className="mr-2 flex items-center gap-2 text-sm text-text-700">
                <Switch
                  checked={rule.active}
                  onCheckedChange={onToggle}
                  aria-label={t("activeNamed", { name: rule.name })}
                />
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={index === 0 || busy}
                aria-label={t("moveUp", { name: rule.name })}
                onClick={() => onMove(-1)}
              >
                <ArrowUp aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={index === count - 1 || busy}
                aria-label={t("moveDown", { name: rule.name })}
                onClick={() => onMove(1)}
              >
                <ArrowDown aria-hidden />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={t("editNamed", { name: rule.name })} onClick={onEdit}>
                <Pencil aria-hidden />
              </Button>
            </>
          ) : null}
          <Button variant="ghost" size="icon-sm" aria-label={t("removeNamed", { name: rule.name })} onClick={onRemove}>
            <Trash2 aria-hidden />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
