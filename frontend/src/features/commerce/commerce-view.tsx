"use client";

import { useIsMutating, useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CircleHelp,
  Download,
  History,
  LoaderCircle,
  Plug,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Store,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatDateTime } from "@/lib/format";
import { useCan, useSession, useTimeZone } from "@/lib/session";
import type { CommerceOperation, CommercePrincipal, CommerceRequest } from "./contracts";
import { CommerceFieldEditor } from "./field-editor";
import { commerceInput, commerceReview, type DraftObject, type FormIssue } from "./form-values";
import { useCommerceLabel } from "./labels";
import { CommerceResultView } from "./result-view";

const unfinished = (status: CommerceRequest["status"]) => status === "queued" || status === "running";
const requestTone = (status: CommerceRequest["status"]) =>
  status === "succeeded" ? "success" : status === "failed" ? "danger" : status === "uncertain" ? "warning" : "info";

function useCommerceAccessKey(): string {
  const session = useSession();
  return JSON.stringify([session.tenant.id, session.permissions, session.storeScope, session.warehouseScope]);
}
export function hasOperationScopes(
  operation: Pick<CommerceOperation, "scopes" | "scopeMode" | "authMode">,
  principal: Pick<CommercePrincipal, "scopes">,
): boolean {
  if (operation.authMode === "shopee_app_program") return true;
  return operation.scopeMode === "any"
    ? operation.scopes.some((scope) => principal.scopes.includes(scope))
    : operation.scopes.every((scope) => principal.scopes.includes(scope));
}

export function hasSellerType(operation: CommerceOperation, principal: CommercePrincipal): boolean {
  if (!operation.accountRequirements?.length) return true;
  return (
    (principal.sellerType === "local" || principal.sellerType === "cross_border") &&
    operation.accountRequirements.includes(principal.sellerType)
  );
}

export function hasAccountProgram(operation: CommerceOperation, principal: CommercePrincipal): boolean {
  if (principal.channel !== "shopee" || principal.kind === "seller") return true;
  return (
    operation.appPrograms?.includes(
      principal.program === "live"
        ? "Livestream Management"
        : principal.program === "video"
          ? "Shopee Video Management"
          : "unsupported",
    ) ?? false
  );
}

export function hasTenantPermissions(operation: CommerceOperation, permissions: readonly string[]): boolean {
  return (
    Array.isArray(operation.requiredPermissions) &&
    operation.requiredPermissions.every((required) => permissions.includes(required))
  );
}

export function CommerceView() {
  const t = useTranslations("commerce");
  const label = useCommerceLabel();
  const can = useCan();
  const permissions = useSession().permissions;
  const accessKey = useCommerceAccessKey();
  const mobile = useIsMobile();
  const [principalId, setPrincipalId] = useState("");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("all");
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState(false);
  const [operation, setOperation] = useState<CommerceOperation>();
  const [operationDraft, setOperationDraft] = useState<DraftObject>({});
  const [requestDrafts, setRequestDrafts] = useState<Record<string, DraftObject>>({});
  const [history, setHistory] = useState(false);
  const [receipt, setReceipt] = useState<CommerceRequest>();
  const catalog = useQuery({
    queryKey: ["commerce", "operations"],
    queryFn: () => unwrap(api.GET("/v1/commerce/operations")),
    enabled: can("commerce:read"),
  });
  const accounts = useQuery({
    queryKey: ["commerce", "principals", accessKey],
    queryFn: () => unwrap(api.GET("/v1/commerce/principals")),
    enabled: can("commerce:read"),
  });
  const principal = accounts.data?.items.find((item) => item.id === principalId) ?? accounts.data?.items[0];
  const operations =
    catalog.data?.items.filter(
      (item) => item.channel === principal?.channel && item.principalKind === principal?.kind,
    ) ?? [];
  const groups = [...new Set(operations.map((item) => item.group))].sort();
  const filtered = operations.filter(
    (item) =>
      (group === "all" || item.group === group) &&
      `${label(item.title)} ${label(item.group)} ${item.title} ${item.group}`
        .toLocaleLowerCase("id")
        .includes(search.toLocaleLowerCase("id")),
  );
  const pageSize = mobile ? 1 : 6;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  if (!can("commerce:read")) return <PageHeader title={t("title")} description={t("noAccess")} />;
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          <Button variant="secondary" size="sm" onClick={() => setHistory(true)}>
            <History aria-hidden />
            {t("history")}
          </Button>
        }
      />
      {catalog.isPending || accounts.isPending ? (
        <div role="status" aria-label={t("loading")}>
          <Skeleton className="h-20" />
          <p className="mt-2 text-sm text-text-500">{t("loading")}</p>
        </div>
      ) : catalog.isError || accounts.isError ? (
        <ErrorState
          error={catalog.error ?? accounts.error}
          onRetry={() => {
            catalog.refetch();
            accounts.refetch();
          }}
        />
      ) : !principal ? (
        <EmptyState
          icon={Plug}
          title={t("emptyAccounts")}
          body={t("emptyAccountsHint")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="secondary" asChild>
                <Link href="/integrasi">{t("connectStore")}</Link>
              </Button>
              <Button asChild>
                <Link href="/affiliate/akun">{t("connectCreator")}</Link>
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid gap-3">
          <div className="grid min-w-0 gap-1.5">
            <label htmlFor="commerce-principal" className="text-sm font-medium">
              {t("account")}
            </label>
            <Select
              value={principal.id}
              onValueChange={(next) => {
                setPrincipalId(next);
                setPage(0);
                setGroup("all");
              }}
            >
              <SelectTrigger id="commerce-principal" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.data.items.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name} · {t(`channel.${account.channel}`)} · {t(`kind.${account.kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-w-0 gap-2">
            <div className="relative min-w-0 flex-1">
              <Search aria-hidden className="pointer-events-none absolute top-3 left-3 z-10 size-4 text-text-500" />
              <Input
                type="search"
                className="pl-9"
                aria-label={t("search")}
                placeholder={t("search")}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
                maxLength={150}
              />
            </div>
            <Button
              size="icon"
              variant={group === "all" ? "secondary" : "default"}
              aria-label={t("filter")}
              onClick={() => setFilters(true)}
            >
              <SlidersHorizontal aria-hidden />
            </Button>
          </div>
          {!filtered.length ? (
            <div className="rounded-xl border bg-surface p-5 text-sm text-text-500">{t("noOperations")}</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize).map((item) => {
                const enabled =
                  item.available &&
                  ["active", "token_expiring"].includes(principal.status) &&
                  hasOperationScopes(item, principal) &&
                  hasSellerType(item, principal) &&
                  hasAccountProgram(item, principal) &&
                  hasTenantPermissions(item, permissions) &&
                  (!item.write || (can("commerce:write") && !principal.readOnly));
                return (
                  <Card key={item.id} className="gap-2 p-3 md:p-4">
                    <div className="flex min-w-0 items-start gap-2">
                      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-50 text-primary">
                        <Store className="size-4" aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs text-text-500">{label(item.group)}</p>
                        <h2 className="line-clamp-2 text-sm leading-snug font-semibold">{label(item.title)}</h2>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <StatusPill tone={enabled ? (item.write ? "warning" : "info") : "neutral"}>
                        {t(enabled ? (item.write ? "writeAction" : "readAction") : "requirements")}
                      </StatusPill>
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={t(enabled ? "openOperationName" : "requirementsName", { name: label(item.title) })}
                        onClick={() => {
                          setOperationDraft({});
                          setOperation(item);
                        }}
                      >
                        {t(enabled ? "open" : "requirements")}
                        {enabled ? <ArrowRight aria-hidden /> : <CircleHelp aria-hidden />}
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
              {t("previous")}
            </Button>
            <span className="text-xs text-text-500">{t("page", { count: currentPage + 1 })}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={(currentPage + 1) * pageSize >= filtered.length}
              onClick={() => setPage(currentPage + 1)}
            >
              {t("next")}
            </Button>
          </div>
        </div>
      )}
      <Dialog open={filters} onOpenChange={setFilters}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("filterTitle")}</DialogTitle>
            <DialogDescription>{t("filterHint")}</DialogDescription>
          </DialogHeader>
          <label className="text-sm font-medium" htmlFor="commerce-group">
            {t("group")}
          </label>
          <Select
            value={group}
            onValueChange={(next) => {
              setGroup(next);
              setPage(0);
            }}
          >
            <SelectTrigger id="commerce-group" className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allGroups")}</SelectItem>
              {groups.map((value) => (
                <SelectItem key={value} value={value}>
                  {label(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button onClick={() => setFilters(false)}>{t("apply")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {operation && principal ? (
        <OperationDialog
          operation={operation}
          principal={principal}
          initialDraft={operationDraft}
          onClose={() => setOperation(undefined)}
          onSubmitted={(request, submittedDraft) => {
            setOperation(undefined);
            setRequestDrafts({ ...requestDrafts, [request.id]: submittedDraft });
            setReceipt(request);
          }}
        />
      ) : null}
      {history ? (
        <HistoryDialog
          principalId={principal?.id}
          operations={catalog.data?.items ?? []}
          onClose={() => setHistory(false)}
          onSelect={(request) => {
            setHistory(false);
            setReceipt(request);
          }}
        />
      ) : null}
      {receipt ? (
        <RequestDialog
          initial={receipt}
          operation={catalog.data?.items.find((item) => item.id === receipt.operationId)}
          onClose={() => setReceipt(undefined)}
          onNextPage={(nextOperation, field, cursor) => {
            setOperationDraft({ ...requestDrafts[receipt.id], [field]: cursor });
            setPrincipalId(receipt.principalId);
            setReceipt(undefined);
            setOperation(nextOperation);
          }}
        />
      ) : null}
    </>
  );
}

function OperationDialog({
  operation,
  principal,
  initialDraft,
  onClose,
  onSubmitted,
}: {
  operation: CommerceOperation;
  principal: CommercePrincipal;
  initialDraft: DraftObject;
  onClose: () => void;
  onSubmitted: (request: CommerceRequest, draft: DraftObject) => void;
}) {
  const t = useTranslations("commerce");
  const label = useCommerceLabel();
  const can = useCan();
  const permissions = useSession().permissions;
  const timeZone = useTimeZone();
  const uploading = useIsMutating({ mutationKey: ["commerce", "upload", operation.id, principal.id] }) > 0;
  const [draft, setDraft] = useState<DraftObject>(initialDraft);
  const [reviewInputs, setReviewInputs] = useState(false);
  const [page, setPage] = useState(0);
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [requestKey] = useState(() => crypto.randomUUID());
  const categories = principal.categories ?? [];
  const chooseCategory = !!operation.categoryAsset && categories.length > 1;
  const categoryStep = chooseCategory && page === 0;
  const fieldPage = page - (chooseCategory ? 1 : 0);
  const [categoryError, setCategoryError] = useState(false);
  const categoryId = typeof draft.categoryAssetId === "string" ? draft.categoryAssetId : "";
  const requestInput = () => ({
    ...commerceInput(operation.fields, draft, timeZone).input,
    ...(categoryId ? { categoryAssetId: Number(categoryId) } : {}),
  });
  const pages = Math.ceil(operation.fields.length / 2) + (chooseCategory ? 1 : 0);
  const reviewing = page >= pages;
  const fields = operation.fields.slice(Math.max(0, fieldPage * 2), Math.max(0, fieldPage * 2) + 2);
  const missingScopes = !hasOperationScopes(operation, principal);
  const blocked = !operation.available
    ? (operation.unavailableReason ?? t("contractUnavailable"))
    : !["active", "token_expiring"].includes(principal.status)
      ? t("accountInactive")
      : !hasTenantPermissions(operation, permissions)
        ? t("permissionDenied")
        : missingScopes
          ? t("missingScopes")
          : !hasSellerType(operation, principal)
            ? t("sellerTypeUnavailable")
            : !hasAccountProgram(operation, principal)
              ? t("programUnavailable")
              : operation.write && principal.readOnly
                ? t("readOnly")
                : operation.categoryAsset && !categories.length
                  ? t("missingCategory")
                  : operation.write && !can("commerce:write")
                    ? t("writeDenied")
                    : null;
  const submit = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/commerce/requests", {
          params: { header: { "Idempotency-Key": requestKey } },
          body: {
            operationId: operation.id,
            principalId: principal.id,
            input: requestInput(),
            confirmed: operation.write ? confirmed : false,
          },
        }),
      ),
    onSuccess: (request) => onSubmitted(request, draft),
  });
  const next = () => {
    if (categoryStep) {
      if (!categoryId) {
        setCategoryError(true);
        return;
      }
      setPage(page + 1);
      return;
    }
    const result = commerceInput(operation.fields, draft, timeZone);
    const relevant = reviewing
      ? result.issues
      : result.issues.filter((issue) =>
          fields.some((field) => issue.path === field.name || issue.path.startsWith(`${field.name}.`)),
        );
    setIssues(relevant);
    if (relevant.length) {
      if (reviewing)
        setPage(
          Math.floor(
            Math.max(
              0,
              operation.fields.findIndex((field) => relevant[0]?.path.startsWith(field.name)),
            ) / 2,
          ) + (chooseCategory ? 1 : 0),
        );
      return;
    }
    if (reviewing) submit.mutate();
    else setPage(page + 1);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submit.isPending && !uploading) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={!submit.isPending && !uploading}>
        <DialogHeader>
          <DialogTitle className="line-clamp-2 leading-snug">{label(operation.title)}</DialogTitle>
          <DialogDescription className="truncate">
            {principal.name} · {t(`channel.${principal.channel}`)} · {t(`kind.${principal.kind}`)}
          </DialogDescription>
        </DialogHeader>
        {principal.regionVerified === false ? (
          <p role="status" className="rounded-xl bg-warning-soft p-3 text-sm text-warning">
            {t("regionUnverified")}
          </p>
        ) : null}
        {blocked ? (
          <div className="grid gap-3">
            <div className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-sm text-warning">
              <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
              <p>{blocked}</p>
            </div>
            {missingScopes && operation.scopes.length ? (
              <p className="break-all text-xs text-text-500">
                {t(operation.scopeMode === "any" ? "oneScopeRequired" : "scopesRequired", {
                  scopes: operation.scopes.join(", "),
                })}
              </p>
            ) : null}
            <p className="text-sm text-text-500">{t("requirementsHint")}</p>
          </div>
        ) : (
          <form
            id="commerce-operation-form"
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              next();
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <StatusPill tone={operation.write ? "warning" : "info"}>
                {t(operation.write ? "writeAction" : "readAction")}
              </StatusPill>
              <span className="text-xs text-text-500">{t("step", { current: page + 1, count: pages + 1 })}</span>
            </div>
            {categoryStep ? (
              <div className="grid gap-2">
                <label htmlFor="commerce-category-asset" className="font-medium">
                  {t("assetCategory")}
                </label>
                <Select
                  value={categoryId}
                  onValueChange={(value) => {
                    setDraft({ ...draft, categoryAssetId: value });
                    setCategoryError(false);
                  }}
                >
                  <SelectTrigger id="commerce-category-asset" className="w-full min-w-0" aria-invalid={categoryError}>
                    <SelectValue placeholder={t("chooseValue")} />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((category) => (
                      <SelectItem key={category.id} value={String(category.id)}>
                        {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-text-500">{t("assetCategoryHint")}</p>
                {categoryError ? (
                  <p role="alert" className="text-xs text-danger">
                    {t("validation.required")}
                  </p>
                ) : null}
              </div>
            ) : reviewing ? (
              <div className="grid gap-3">
                <div className="rounded-xl border bg-surface-2 p-3 text-sm">
                  <p className="font-semibold">{t("reviewTitle")}</p>
                  <p className="mt-1 text-text-500">{t(operation.write ? "reviewWrite" : "reviewRead")}</p>
                </div>
                {operation.eligibility === "unverified" ? (
                  <p className="text-xs text-text-500">{t("programEligibility")}</p>
                ) : null}
                {operation.fields.length ? (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setReviewInputs(true)}>
                    {t("reviewInputs")}
                  </Button>
                ) : null}
                {operation.write ? (
                  <label
                    htmlFor="commerce-confirm-write"
                    className="flex items-start gap-3 rounded-xl border p-3 text-sm"
                  >
                    <Checkbox
                      id="commerce-confirm-write"
                      checked={confirmed}
                      onCheckedChange={(checked) => setConfirmed(checked === true)}
                      disabled={submit.isPending}
                      className="mt-0.5 shrink-0"
                    />
                    <span>{t("confirmWrite", { account: principal.name })}</span>
                  </label>
                ) : null}
              </div>
            ) : (
              fields.map((field) => (
                <CommerceFieldEditor
                  key={field.name}
                  field={field}
                  uploadContext={{ operationId: operation.id, principalId: principal.id }}
                  value={draft[field.name]}
                  issue={issues.find((issue) => issue.path === field.name || issue.path.startsWith(`${field.name}.`))}
                  disabled={submit.isPending || uploading}
                  onChange={(value) => {
                    const nextDraft = { ...draft };
                    if (value === undefined) delete nextDraft[field.name];
                    else nextDraft[field.name] = value;
                    setDraft(nextDraft);
                    setIssues([]);
                  }}
                />
              ))
            )}
            {submit.isError ? (
              <p role="alert" className="text-sm text-danger">
                {errorMessage(submit.error)}
              </p>
            ) : null}
            {submit.isPending ? (
              <p role="status" className="flex items-center gap-2 text-sm text-text-500">
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
                {t("submitting")}
              </p>
            ) : null}
          </form>
        )}
        <DialogFooter>
          {blocked ? (
            <Button variant="secondary" onClick={onClose}>
              {t("close")}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                disabled={submit.isPending || uploading}
                onClick={() => {
                  if (page === 0) onClose();
                  else {
                    setPage(page - 1);
                    setIssues([]);
                  }
                }}
              >
                {t(page === 0 ? "cancel" : "previous")}
              </Button>
              <Button
                type="submit"
                form="commerce-operation-form"
                disabled={submit.isPending || uploading || (reviewing && operation.write && !confirmed)}
              >
                {submit.isPending ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
                {t(reviewing ? (operation.write ? "confirmAndSend" : "send") : "next")}
              </Button>
            </>
          )}
        </DialogFooter>
        {reviewInputs ? (
          <Dialog open onOpenChange={setReviewInputs}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{t("reviewInputs")}</DialogTitle>
                <DialogDescription>{t("reviewInputsHint")}</DialogDescription>
              </DialogHeader>
              <CommerceResultView
                value={{
                  ...commerceReview(operation.fields, draft, timeZone),
                  ...(categoryId
                    ? { [t("assetCategory")]: categories.find((category) => String(category.id) === categoryId)?.name }
                    : {}),
                }}
              />
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => setReviewInputs(false)}>
                  {t("close")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({
  principalId,
  operations,
  onClose,
  onSelect,
}: {
  principalId?: string;
  operations: CommerceOperation[];
  onClose: () => void;
  onSelect: (request: CommerceRequest) => void;
}) {
  const t = useTranslations("commerce");
  const label = useCommerceLabel();
  const zone = useTimeZone();
  const permissionsKey = useCommerceAccessKey();
  const [cursor, setCursor] = useState<string>();
  const [back, setBack] = useState<(string | undefined)[]>([]);
  const list = useQuery({
    queryKey: ["commerce", "history", principalId, cursor, permissionsKey],
    queryFn: () => unwrap(api.GET("/v1/commerce/requests", { params: { query: { principalId, cursor, limit: 3 } } })),
    refetchInterval: (query) =>
      !query.state.error && query.state.data?.items.some((request) => unfinished(request.status)) ? 3000 : false,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("historyTitle")}</DialogTitle>
          <DialogDescription>{t("historyHint")}</DialogDescription>
        </DialogHeader>
        {list.isPending ? (
          <p role="status" className="text-sm text-text-500">
            {t("loadingHistory")}
          </p>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : !list.data.items.length ? (
          <p className="text-sm text-text-500">{t("emptyHistory")}</p>
        ) : (
          <>
            <div className="grid gap-2">
              {list.data.items.map((request) => (
                <button
                  type="button"
                  key={request.id}
                  className="grid min-w-0 gap-2 rounded-xl border bg-surface p-3 text-left outline-none hover:border-primary focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => onSelect(request)}
                >
                  <span className="line-clamp-1 text-sm font-medium">
                    {label(
                      operations.find((operation) => operation.id === request.operationId)?.title ??
                        t("marketplaceRequest"),
                    )}
                  </span>
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <StatusPill tone={requestTone(request.status)}>{t(`status.${request.status}`)}</StatusPill>
                    <span className="text-xs text-text-500">{formatDateTime(request.createdAt, zone)}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={!back.length || list.isFetching}
                onClick={() => {
                  setCursor(back.at(-1));
                  setBack(back.slice(0, -1));
                }}
              >
                {t("previous")}
              </Button>
              <span className="text-xs text-text-500">{t("page", { count: back.length + 1 })}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!list.data.nextCursor || list.isFetching}
                onClick={() => {
                  setBack([...back, cursor]);
                  setCursor(list.data.nextCursor ?? undefined);
                }}
              >
                {t("next")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RequestDialog({
  initial,
  operation,
  onClose,
  onNextPage,
}: {
  initial: CommerceRequest;
  operation?: CommerceOperation;
  onClose: () => void;
  onNextPage: (operation: CommerceOperation, field: string, cursor: string) => void;
}) {
  const t = useTranslations("commerce");
  const label = useCommerceLabel();
  const zone = useTimeZone();
  const permissionsKey = useCommerceAccessKey();
  const [initialPermissionsKey] = useState(permissionsKey);
  const request = useQuery({
    queryKey: ["commerce", "request", initial.id, permissionsKey],
    queryFn: () => unwrap(api.GET("/v1/commerce/requests/{id}", { params: { path: { id: initial.id } } })),
    initialData: permissionsKey === initialPermissionsKey ? initial : undefined,
    refetchInterval: (query) =>
      !query.state.error && query.state.data && unfinished(query.state.data.status) ? 2000 : false,
  });
  const item = request.data;
  const cursorField = operation?.fields.find((field) =>
    /^(?:query|body)\.(?:page_token|cursor|pagination_token|cursor_token)$/.test(field.name),
  );
  if (!item)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("requestTitle")}</DialogTitle>
            <DialogDescription>{t("checkingCurrentAccess")}</DialogDescription>
          </DialogHeader>
          {request.isError ? (
            <ErrorState error={request.error} onRetry={() => request.refetch()} />
          ) : (
            <p role="status" className="text-sm text-text-500">
              {t("loadingHistory")}
            </p>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>
              {t("close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("requestTitle")}</DialogTitle>
          <DialogDescription className="line-clamp-2">
            {label(operation?.title ?? t("marketplaceRequest"))}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <StatusPill tone={requestTone(item.status)}>
            {item.status === "succeeded" && item.result?.acknowledgement === "accepted"
              ? t("accepted")
              : t(`status.${item.status}`)}
          </StatusPill>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("refreshStatus")}
            onClick={() => request.refetch()}
            disabled={request.isFetching}
          >
            <RefreshCw className={request.isFetching ? "animate-spin" : ""} aria-hidden />
          </Button>
        </div>
        {request.isError ? (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(request.error)}
          </p>
        ) : null}
        <Tabs defaultValue="result">
          <TabsList className="w-full">
            <TabsTrigger value="result">{t("resultTab")}</TabsTrigger>
            <TabsTrigger value="details">{t("detailsTab")}</TabsTrigger>
          </TabsList>
          <TabsContent value="result" className="mt-3">
            {unfinished(item.status) ? (
              <div role="status" className="flex items-start gap-3 rounded-xl bg-primary-50 p-4 text-sm text-primary">
                <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden />
                <p>{t(`progress.${item.status}`)}</p>
              </div>
            ) : item.status === "uncertain" ? (
              <p role="alert" className="rounded-xl bg-warning-soft p-3 text-sm text-warning">
                {t("uncertainHint")}
              </p>
            ) : item.status === "failed" ? (
              <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">
                {item.errorMessage ?? t("failedHint")}
              </p>
            ) : (
              <div className="grid gap-3">
                {item.result?.acknowledgement === "accepted" ? (
                  <p className="rounded-xl bg-primary-50 p-3 text-xs text-primary">{t("acceptedHint")}</p>
                ) : null}
                <CommerceResultView value={item.result?.data ?? null} />
                {item.result?.artifact ? (
                  <div className="grid gap-1.5">
                    <Button variant="secondary" size="sm" asChild>
                      <a href={`/v1/commerce/requests/${item.id}/download`}>
                        <Download aria-hidden />
                        {t("downloadResult")}
                      </a>
                    </Button>
                    <p className="text-xs text-text-500">
                      {t("downloadExpires", { date: formatDateTime(item.result.artifact.expiresAt, zone) })}
                    </p>
                  </div>
                ) : null}
                {item.nextCursor && operation && cursorField ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => onNextPage(operation, cursorField.name, item.nextCursor!)}
                  >
                    {t("nextResults")}
                    <ArrowRight aria-hidden />
                  </Button>
                ) : item.nextCursor ? (
                  <p className="text-xs text-text-500">{t("moreResultsHint")}</p>
                ) : null}
              </div>
            )}
          </TabsContent>
          <TabsContent value="details" className="mt-3">
            <dl className="grid gap-3 text-sm">
              <div>
                <dt className="text-xs text-text-500">{t("requestId")}</dt>
                <dd className="mt-1 break-all font-mono text-xs">{item.id}</dd>
              </div>
              <div>
                <dt className="text-xs text-text-500">{t("createdAt")}</dt>
                <dd className="mt-1">{formatDateTime(item.createdAt, zone)}</dd>
              </div>
              {item.finishedAt ? (
                <div>
                  <dt className="text-xs text-text-500">{t("finishedAt")}</dt>
                  <dd className="mt-1">{formatDateTime(item.finishedAt, zone)}</dd>
                </div>
              ) : null}
              {item.errorCode ? (
                <div>
                  <dt className="text-xs text-text-500">{t("errorCode")}</dt>
                  <dd className="mt-1 break-all font-mono text-xs">{item.errorCode}</dd>
                </div>
              ) : null}
            </dl>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
