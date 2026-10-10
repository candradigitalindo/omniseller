"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MailPlus, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2, UsersRound } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ChannelIcon } from "@/components/common/channel";
import { Field, fieldProps } from "@/components/common/field";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStores } from "@/features/stores/use-store-modes";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { formatDateTime, formatRelative } from "@/lib/format";
import { type Permission, useCan, useHasFeature, useSession, useTimeZone } from "@/lib/session";
import {
  copiedPermissions,
  emailProblem,
  grantableRoles,
  INVITATION_TONE,
  type Invitation,
  isKnownModule,
  orderedRoles,
  type PermissionInfo,
  permissionMatrix,
  type Role,
  roleBlock,
  roleProblems,
  scopeBody,
  scopeSummary,
  USER_TONE,
  type User,
} from "./team-meta";

const TABS = ["anggota", "undangan", "peran"] as const;

function useRoles() {
  return useQuery({ queryKey: ["roles"], queryFn: () => unwrap(api.GET("/v1/roles")), staleTime: 5 * 60_000 });
}
function usePermissions() {
  return useQuery({
    queryKey: ["permissions"],
    queryFn: () => unwrap(api.GET("/v1/permissions")),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
function useWarehouses() {
  return useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 5 * 60_000,
  });
}

/**
 * L41 Tim dan Peran (DOKUMEN-UI-UX 14.8): who works in the business, with which roles and over which stores
 * and warehouses; invitations by email; what each role may do. Built-in roles are the same everywhere;
 * custom roles (FR-USR-01, backend doc 8.33) come with plans that have `custom_roles`.
 */
export function TeamView() {
  const t = useTranslations("team");
  const can = useCan();
  const { params, set } = useUrlParams();
  const [inviting, setInviting] = useState(false);
  if (!can("settings:user")) return <PageHeader title={t("title")} description={t("noAccess")} />;
  const tab = TABS.find((x) => x === params.get("tab")) ?? "anggota";
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button onClick={() => setInviting(true)}>
            <MailPlus aria-hidden />
            {t("invite")}
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={(v) => set({ tab: v === "anggota" ? null : v })}>
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
        <TabsContent value="anggota">
          <Members />
        </TabsContent>
        <TabsContent value="undangan">
          <Invitations onInvite={() => setInviting(true)} />
        </TabsContent>
        <TabsContent value="peran">
          <RolesTab />
        </TabsContent>
      </Tabs>
      {inviting ? <InviteDialog onClose={() => setInviting(false)} onDone={() => set({ tab: "undangan" })} /> : null}
    </>
  );
}

function Members() {
  const t = useTranslations("team");
  const tz = useTimeZone();
  const me = useSession();
  const { byId } = useStores();
  const warehouses = useWarehouses();
  const [editing, setEditing] = useState<{ user: User; what: "roles" | "scope" } | null>(null);
  const [confirming, setConfirming] = useState<{ user: User; what: "signOut" | "reset" } | null>(null);
  const queryClient = useQueryClient();
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => unwrap(api.GET("/v1/users", { params: { query: { limit: 200 } } })),
  });
  const status = useMutation({
    mutationFn: (u: User) =>
      unwrap(
        api.PATCH("/v1/users/{id}", {
          params: { path: { id: u.id } },
          body: { status: u.status === "disabled" ? "active" : "disabled" },
        }),
      ),
    onSuccess: (u) => {
      toast.success(u.status === "disabled" ? t("disabled", { name: u.name }) : t("enabled", { name: u.name }));
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  // a lost phone or laptop: sign the member out everywhere, or turn off a two-step login they cannot pass
  const signOut = useMutation({
    mutationFn: (u: User) => unwrap(api.POST("/v1/users/{id}/sessions/revoke", { params: { path: { id: u.id } } })),
    onSuccess: (r, u) => {
      setConfirming(null);
      toast.success(t("signedOut", { name: u.name, count: r.revoked }));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const resetTwoFactor = useMutation({
    mutationFn: (u: User) => unwrap(api.POST("/v1/users/{id}/two-factor/reset", { params: { path: { id: u.id } } })),
    onSuccess: (u) => {
      setConfirming(null);
      toast.success(t("resetDone", { name: u.name }));
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const confirm = confirming?.what === "signOut" ? signOut : resetTwoFactor;
  const storeNames = new Map([...byId.values()].map((s) => [s.id, s.name]));
  const warehouseNames = new Map((warehouses.data?.items ?? []).map((w) => [w.id, w.name]));

  if (users.isPending) return <Skeleton className="h-48" />;
  if (users.isError) {
    return (
      <Card>
        <ErrorState error={users.error} onRetry={() => users.refetch()} />
      </Card>
    );
  }
  const scope = (ids: string[] | null, names: Map<string, string>, all: string) => {
    const s = scopeSummary(ids, names);
    return s.all ? all : s.names.join(", ");
  };
  return (
    <Card className="gap-0 py-0">
      <div className="hidden overflow-x-auto md:block">
        <Table>
          <TableHeader className="bg-surface-2">
            <TableRow>
              <TableHead>{t("colMember")}</TableHead>
              <TableHead>{t("colRoles")}</TableHead>
              <TableHead>{t("colScope")}</TableHead>
              <TableHead>{t("colLastLogin")}</TableHead>
              <TableHead>{t("colStatus")}</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.data.items.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="grid gap-0.5">
                    <span className="font-medium text-text-900">
                      {u.name}
                      {u.id === me.user.id ? <span className="font-normal text-text-500"> ({t("you")})</span> : null}
                    </span>
                    <span className="text-[13px] text-text-500">{u.email}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    {u.roles.map((r) => (
                      <StatusPill key={r.id} tone="info" icon={UsersRound}>
                        {r.name}
                      </StatusPill>
                    ))}
                  </span>
                </TableCell>
                <TableCell className="max-w-64 text-[13px] text-text-700">
                  <div className="grid gap-0.5">
                    <span className="truncate">{scope(u.storeIds, storeNames, t("allStores"))}</span>
                    <span className="truncate text-text-500">
                      {scope(u.warehouseIds, warehouseNames, t("allWarehouses"))}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-[13px] text-text-700">
                  {u.lastLoginAt ? formatRelative(u.lastLoginAt, tz) : t("neverLoggedIn")}
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    <StatusPill tone={USER_TONE[u.status]}>{t(`userStatus_${u.status}`)}</StatusPill>
                    {u.twoFactorEnabled ? (
                      <StatusPill tone="success" icon={ShieldCheck}>
                        {t("twoFactorPill")}
                      </StatusPill>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell>
                  <MemberActions
                    user={u}
                    self={u.id === me.user.id}
                    onEdit={(what) => setEditing({ user: u, what })}
                    onStatus={() => status.mutate(u)}
                    onConfirm={(what) => setConfirming({ user: u, what })}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="divide-y md:hidden">
        {users.data.items.map((u) => (
          <li key={u.id} className="grid gap-2 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="grid min-w-0 gap-0.5">
                <span className="truncate font-medium text-text-900">{u.name}</span>
                <span className="truncate text-[13px] text-text-500">{u.email}</span>
              </div>
              <MemberActions
                user={u}
                self={u.id === me.user.id}
                onEdit={(what) => setEditing({ user: u, what })}
                onStatus={() => status.mutate(u)}
                onConfirm={(what) => setConfirming({ user: u, what })}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusPill tone={USER_TONE[u.status]}>{t(`userStatus_${u.status}`)}</StatusPill>
              {u.twoFactorEnabled ? (
                <StatusPill tone="success" icon={ShieldCheck}>
                  {t("twoFactorPill")}
                </StatusPill>
              ) : null}
              {u.roles.map((r) => (
                <StatusPill key={r.id} tone="info" icon={UsersRound}>
                  {r.name}
                </StatusPill>
              ))}
            </div>
            <span className="text-[13px] text-text-500">
              {scope(u.storeIds, storeNames, t("allStores"))} ·{" "}
              {scope(u.warehouseIds, warehouseNames, t("allWarehouses"))}
            </span>
          </li>
        ))}
      </ul>
      {editing?.what === "roles" ? <RolesDialog user={editing.user} onClose={() => setEditing(null)} /> : null}
      {editing?.what === "scope" ? <ScopeDialog user={editing.user} onClose={() => setEditing(null)} /> : null}
      <Dialog open={confirming !== null} onOpenChange={(v) => !v && setConfirming(null)}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>
              {confirming?.what === "signOut"
                ? t("signOutTitle", { name: confirming.user.name })
                : t("resetTitle", { name: confirming?.user.name ?? "" })}
            </DialogTitle>
            <DialogDescription>
              {confirming?.what === "signOut"
                ? t("signOutBody", { name: confirming.user.name })
                : t("resetBody", { name: confirming?.user.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={confirm.isPending}
              onClick={() => confirming && confirm.mutate(confirming.user)}
            >
              {confirming?.what === "signOut" ? t("signOutConfirm") : t("resetConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function MemberActions({
  user: u,
  self,
  onEdit,
  onStatus,
  onConfirm,
}: {
  user: User;
  self: boolean;
  onEdit: (what: "roles" | "scope") => void;
  onStatus: () => void;
  onConfirm: (what: "signOut" | "reset") => void;
}) {
  const t = useTranslations("team");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t("actionsFor", { name: u.name })}>
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      {/* wide enough that "Keluarkan dari semua perangkat" stays on one line */}
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuItem onSelect={() => onEdit("roles")}>{t("changeRoles")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onEdit("scope")}>{t("changeScope")}</DropdownMenuItem>
        {!self && u.status === "active" ? (
          <DropdownMenuItem onSelect={() => onConfirm("signOut")}>{t("signOutEverywhere")}</DropdownMenuItem>
        ) : null}
        {!self && u.twoFactorEnabled ? (
          <DropdownMenuItem onSelect={() => onConfirm("reset")}>{t("resetTwoFactor")}</DropdownMenuItem>
        ) : null}
        {!self && u.status !== "invited" ? (
          <DropdownMenuItem variant={u.status === "disabled" ? "default" : "destructive"} onSelect={onStatus}>
            {u.status === "disabled" ? t("enable") : t("disable")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RolesDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const t = useTranslations("team");
  const tCommon = useTranslations("common");
  const me = useSession();
  const roles = useRoles();
  const queryClient = useQueryClient();
  const customAllowed = useHasFeature("custom_roles");
  const held = new Set(user.roles.map((r) => r.id));
  const [chosen, setChosen] = useState<ReadonlySet<string>>(held);
  const [problem, setProblem] = useState<string | null>(null);
  const blockOf = (r: Role) => roleBlock(r, { mine: me.permissions, customAllowed, held });
  const save = useMutation({
    mutationFn: () =>
      unwrap(api.PUT("/v1/users/{id}/roles", { params: { path: { id: user.id } }, body: { roleIds: [...chosen] } })),
    onSuccess: () => {
      toast.success(t("rolesSaved", { name: user.name }));
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: (e) => setProblem(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("rolesTitle", { name: user.name })}</DialogTitle>
          <DialogDescription>{t("rolesBody")}</DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-2">
          <legend className="sr-only">{t("colRoles")}</legend>
          {orderedRoles(roles.data?.items ?? []).map((r) => (
            <Label
              key={r.id}
              htmlFor={`role-${r.id}`}
              className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 font-normal has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-60"
            >
              <Checkbox
                id={`role-${r.id}`}
                className="mt-0.5"
                checked={chosen.has(r.id)}
                disabled={blockOf(r) !== null}
                onCheckedChange={(on) =>
                  setChosen((x) => {
                    const next = new Set(x);
                    if (on) next.add(r.id);
                    else next.delete(r.id);
                    return next;
                  })
                }
              />
              <span className="grid gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-900">
                  {r.name}
                  {r.isSystem ? null : <StatusPill tone="info">{t("customPill")}</StatusPill>}
                </span>
                <span className="text-[13px] text-text-500">
                  {blockOf(r) === "permissions"
                    ? t("roleNotGrantable")
                    : blockOf(r) === "plan"
                      ? t("customNeedsPlan", { plan: me.plan.name })
                      : (r.description ?? "")}
                </span>
              </span>
            </Label>
          ))}
        </fieldset>
        {problem ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {problem}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button disabled={chosen.size === 0} loading={save.isPending} onClick={() => save.mutate()}>
            {tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScopeDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const t = useTranslations("team");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const { byId } = useStores();
  const warehouses = useWarehouses();
  const stores = [...byId.values()];
  const [allStores, setAllStores] = useState(user.storeIds === null);
  const [storeIds, setStoreIds] = useState<string[]>(user.storeIds ?? []);
  const [allWarehouses, setAllWarehouses] = useState(user.warehouseIds === null);
  const [warehouseIds, setWarehouseIds] = useState<string[]>(user.warehouseIds ?? []);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/v1/users/{id}/scopes", {
          params: { path: { id: user.id } },
          body: { storeIds: scopeBody(allStores, storeIds), warehouseIds: scopeBody(allWarehouses, warehouseIds) },
        }),
      ),
    onSuccess: () => {
      toast.success(t("scopeSaved", { name: user.name }));
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: (e) => setProblem(errorMessage(e)),
  });
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  const submit = () => {
    // an empty list would mean "no limit" to the api, the opposite of what an unticked list looks like
    if (!allStores && storeIds.length === 0) setProblem(t("pickStores"));
    else if (!allWarehouses && warehouseIds.length === 0) setProblem(t("pickWarehouses"));
    else save.mutate();
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("scopeTitle", { name: user.name })}</DialogTitle>
          <DialogDescription>{t("scopeBody")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium text-text-700">{t("stores")}</legend>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="scope-all-stores" className="font-normal">
                {t("allStores")}
              </Label>
              <Switch id="scope-all-stores" checked={allStores} onCheckedChange={setAllStores} />
            </div>
            {!allStores
              ? stores.map((s) => (
                  <Label
                    key={s.id}
                    htmlFor={`scope-store-${s.id}`}
                    className="flex cursor-pointer items-center gap-3 font-normal"
                  >
                    <Checkbox
                      id={`scope-store-${s.id}`}
                      checked={storeIds.includes(s.id)}
                      onCheckedChange={(on) => setStoreIds((x) => toggle(x, s.id, on === true))}
                    />
                    <ChannelIcon channel={s.channel} decorative />
                    <span className="text-sm">{s.name}</span>
                  </Label>
                ))
              : null}
          </fieldset>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium text-text-700">{t("warehouses")}</legend>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="scope-all-warehouses" className="font-normal">
                {t("allWarehouses")}
              </Label>
              <Switch id="scope-all-warehouses" checked={allWarehouses} onCheckedChange={setAllWarehouses} />
            </div>
            {!allWarehouses
              ? (warehouses.data?.items ?? []).map((w) => (
                  <Label
                    key={w.id}
                    htmlFor={`scope-wh-${w.id}`}
                    className="flex cursor-pointer items-center gap-3 font-normal"
                  >
                    <Checkbox
                      id={`scope-wh-${w.id}`}
                      checked={warehouseIds.includes(w.id)}
                      onCheckedChange={(on) => setWarehouseIds((x) => toggle(x, w.id, on === true))}
                    />
                    <span className="text-sm">{w.name}</span>
                  </Label>
                ))
              : null}
          </fieldset>
        </div>
        {problem ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {problem}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            {tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations("team");
  const tCommon = useTranslations("common");
  const me = useSession();
  const roles = useRoles();
  const queryClient = useQueryClient();
  const customAllowed = useHasFeature("custom_roles");
  // a custom role goes to someone new only on a plan that has them
  const offered = orderedRoles(grantableRoles(roles.data?.items ?? [], me.permissions)).filter(
    (r) => r.isSystem || customAllowed,
  );
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invite = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/invitations", { body: { email: email.trim(), roleId } })),
    onSuccess: (inv) => {
      toast.success(t("invited", { email: inv.email }));
      void queryClient.invalidateQueries({ queryKey: ["invitations"] });
      onDone();
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.errors.length > 0)
        setErrors(Object.fromEntries(e.errors.map((x) => [x.path, x.message])));
      else setErrors({ root: errorMessage(e) });
    },
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t("inviteTitle")}</DialogTitle>
          <DialogDescription>{t("inviteBody")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const found: Record<string, string> = {};
            const p = emailProblem(email);
            if (p) found.email = t(`email_${p}`);
            if (!roleId) found.roleId = t("pickRole");
            setErrors(found);
            if (Object.keys(found).length === 0) invite.mutate();
          }}
        >
          <Field id="invite-email" label={t("email")} error={errors.email}>
            <Input
              type="email"
              value={email}
              autoComplete="off"
              onChange={(e) => setEmail(e.target.value)}
              {...fieldProps("invite-email", errors.email)}
            />
          </Field>
          <Field id="invite-role" label={t("role")} error={errors.roleId}>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger id="invite-role" className="w-full" aria-invalid={errors.roleId ? true : undefined}>
                <SelectValue placeholder={t("pickRole")} />
              </SelectTrigger>
              <SelectContent>
                {offered.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {errors.root ? (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
              {errors.root}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" loading={invite.isPending}>
              {t("sendInvite")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Invitations({ onInvite }: { onInvite: () => void }) {
  const t = useTranslations("team");
  const tz = useTimeZone();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["invitations"],
    queryFn: () => unwrap(api.GET("/v1/invitations", { params: { query: { limit: 100 } } })),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["invitations"] });
  const resend = useMutation({
    mutationFn: (inv: Invitation) =>
      unwrap(api.POST("/v1/invitations/{id}/resend", { params: { path: { id: inv.id } } })),
    onSuccess: (inv) => {
      toast.success(t("resent", { email: inv.email }));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (inv: Invitation) => unwrap(api.DELETE("/v1/invitations/{id}", { params: { path: { id: inv.id } } })),
    onSuccess: () => {
      toast.success(t("revoked"));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (list.isPending) return <Skeleton className="h-40" />;
  if (list.isError) {
    return (
      <Card>
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      </Card>
    );
  }
  if (list.data.items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={MailPlus}
          title={t("noInvitations")}
          action={<Button onClick={onInvite}>{t("invite")}</Button>}
        />
      </Card>
    );
  }
  return (
    <Card className="gap-0 py-0">
      <ul className="divide-y">
        {list.data.items.map((inv) => (
          <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="grid min-w-0 gap-0.5">
              <span className="truncate font-medium text-text-900">{inv.email}</span>
              <span className="text-[13px] text-text-500">
                {inv.roleName} · {t("expiresAt", { at: formatDateTime(inv.expiresAt, tz) })}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={INVITATION_TONE[inv.status]}>{t(`inviteStatus_${inv.status}`)}</StatusPill>
              <Button
                size="sm"
                variant="secondary"
                loading={resend.isPending && resend.variables?.id === inv.id}
                onClick={() => resend.mutate(inv)}
              >
                {t("resend")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={revoke.isPending && revoke.variables?.id === inv.id}
                onClick={() => revoke.mutate(inv)}
              >
                {t("revoke")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The roles tab: the business's own roles, what every role may do, and the forms for custom roles. */
function RolesTab() {
  const t = useTranslations("team");
  const me = useSession();
  const can = useCan();
  const customAllowed = useHasFeature("custom_roles");
  const roles = useRoles();
  const permissions = usePermissions();
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  if (roles.isPending || permissions.isPending) return <Skeleton className="h-64" />;
  if (roles.isError || permissions.isError) {
    return (
      <Card>
        <ErrorState
          error={roles.error ?? permissions.error}
          onRetry={() => void roles.refetch().then(() => permissions.refetch())}
        />
      </Card>
    );
  }
  const list = orderedRoles(roles.data.items);
  const custom = list.filter((r) => !r.isSystem);
  const mine = new Set<string>(me.permissions);
  const manageable = (r: Role) => r.permissions.every((p) => mine.has(p));
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("customTitle")}</CardTitle>
          <CardDescription>
            {customAllowed ? t("customBody") : t("customLocked", { plan: me.plan.name })}
            {!customAllowed && can("settings:billing") ? (
              <>
                {" "}
                <Link href="/langganan" className="font-medium text-primary hover:underline">
                  {t("seePlans")}
                </Link>
              </>
            ) : null}
          </CardDescription>
          {customAllowed ? (
            <CardAction>
              <Button onClick={() => setEditing("new")}>
                <Plus aria-hidden />
                {t("newRole")}
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="px-0">
          {custom.length === 0 ? (
            <p className="px-(--card-spacing) text-sm text-text-700">{t("customEmpty")}</p>
          ) : (
            <ul className="divide-y" aria-label={t("customTitle")}>
              {custom.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-(--card-spacing) py-3"
                >
                  <div className="grid min-w-0 gap-0.5">
                    <span className="font-medium text-text-900">{r.name}</span>
                    {r.description ? <span className="text-[13px] text-text-700">{r.description}</span> : null}
                    <span className="text-[13px] text-text-500">
                      {t("roleSummary", { permissions: r.permissions.length, users: r.userCount })}
                    </span>
                  </div>
                  {manageable(r) ? (
                    <div className="flex gap-1">
                      {customAllowed ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(r)}
                          aria-label={t("editRoleFor", { name: r.name })}
                        >
                          <Pencil aria-hidden />
                          {t("editRole")}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger"
                        onClick={() => setDeleting(r)}
                        aria-label={t("deleteRoleFor", { name: r.name })}
                      >
                        <Trash2 aria-hidden />
                        {t("deleteRole")}
                      </Button>
                    </div>
                  ) : (
                    <span className="text-[13px] text-text-500">{t("roleNotManageable")}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <RolesMatrix roles={list} permissions={permissions.data.items} />
      {editing ? (
        <RoleEditor
          role={editing === "new" ? null : editing}
          roles={list}
          permissions={permissions.data.items}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {deleting ? <DeleteRoleDialog role={deleting} onClose={() => setDeleting(null)} /> : null}
    </div>
  );
}

function ModuleName({ module }: { module: string }) {
  const t = useTranslations("team");
  return <>{isKnownModule(module) ? t(`module_${module}`) : module}</>;
}

/**
 * A custom role's name, note, and permissions, grouped by module. Only permissions the user holds can be
 * chosen (the api refuses the rest); "Salin izin dari" starts from another role.
 */
function RoleEditor({
  role,
  roles,
  permissions,
  onClose,
}: {
  role: Role | null;
  roles: Role[];
  permissions: PermissionInfo[];
  onClose: () => void;
}) {
  const t = useTranslations("team");
  const tCommon = useTranslations("common");
  const me = useSession();
  const queryClient = useQueryClient();
  const mine = new Set<string>(me.permissions);
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(role?.permissions ?? []));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        permissions: [...chosen] as Permission[],
      };
      return role
        ? unwrap(api.PATCH("/v1/roles/{id}", { params: { path: { id: role.id } }, body }))
        : unwrap(api.POST("/v1/roles", { body }));
    },
    onSuccess: (saved) => {
      toast.success(role ? t("roleSaved", { name: saved.name }) : t("roleCreated", { name: saved.name }));
      void queryClient.invalidateQueries({ queryKey: ["roles"] });
      // members show role names
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.errors.length > 0)
        setErrors(Object.fromEntries(e.errors.map((x) => [x.path, x.message])));
      else setErrors({ root: errorMessage(e) });
    },
  });
  const groups = permissionMatrix(permissions, []);
  const others = roles.filter((r) => r.id !== role?.id);
  const toggle = (code: string, on: boolean) =>
    setChosen((x) => {
      const next = new Set(x);
      if (on) next.add(code);
      else next.delete(code);
      return next;
    });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{role ? t("editRoleTitle", { name: role.name }) : t("createRoleTitle")}</DialogTitle>
          <DialogDescription>
            {role ? t("editRoleBody", { count: role.userCount }) : t("createRoleBody")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const p = roleProblems({ name, permissions: [...chosen] });
            const found: Record<string, string> = {};
            if (p.name) found.name = t(`roleName_${p.name}`);
            if (p.permissions) found.permissions = t("permissions_required");
            setErrors(found);
            if (Object.keys(found).length === 0) save.mutate();
          }}
        >
          <Field id="role-name" label={t("roleName")} error={errors.name}>
            <Input
              value={name}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              {...fieldProps("role-name", errors.name)}
            />
          </Field>
          <Field id="role-description" label={t("roleDescription")} error={errors.description}>
            <Input
              value={description}
              autoComplete="off"
              onChange={(e) => setDescription(e.target.value)}
              {...fieldProps("role-description", errors.description)}
            />
          </Field>
          {others.length > 0 ? (
            <Field id="role-copy" label={t("copyFrom")}>
              <Select
                value=""
                onValueChange={(id) => {
                  const from = others.find((r) => r.id === id);
                  if (from) setChosen(new Set(copiedPermissions(from, me.permissions)));
                }}
              >
                <SelectTrigger id="role-copy" className="w-full">
                  <SelectValue placeholder={t("copyFromNone")} />
                </SelectTrigger>
                <SelectContent>
                  {others.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <fieldset className="grid gap-3" aria-describedby="role-permissions-count">
            <legend className="mb-1 text-sm font-medium text-text-900">{t("permissionsLegend")}</legend>
            <p id="role-permissions-count" className="text-[13px] text-text-500">
              {t("permissionsChosen", { count: chosen.size })}
            </p>
            {groups.map((g) => (
              <fieldset key={g.module} className="grid gap-1.5">
                <legend className="mb-1.5 text-[13px] font-semibold text-text-700">
                  <ModuleName module={g.module} />
                </legend>
                {g.rows.map((p) => {
                  const held = mine.has(p.code);
                  return (
                    <Label
                      key={p.code}
                      htmlFor={`perm-${p.code}`}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 font-normal has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-60"
                    >
                      <Checkbox
                        id={`perm-${p.code}`}
                        className="mt-0.5"
                        checked={chosen.has(p.code)}
                        disabled={!held}
                        onCheckedChange={(on) => toggle(p.code, on === true)}
                      />
                      <span className="grid gap-0.5">
                        <span className="text-sm text-text-900">{p.description ?? p.code}</span>
                        {held ? null : <span className="text-[13px] text-text-500">{t("permissionNotHeld")}</span>}
                      </span>
                    </Label>
                  );
                })}
              </fieldset>
            ))}
          </fieldset>
          {errors.permissions || errors.root ? (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
              {errors.permissions ?? errors.root}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {role ? tCommon("save") : t("createRole")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Deleting a custom role: only once nobody holds it; the api also waits for its open invitations. */
function DeleteRoleDialog({ role, onClose }: { role: Role; onClose: () => void }) {
  const t = useTranslations("team");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const inUse = role.userCount > 0;
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/roles/{id}", { params: { path: { id: role.id } } })),
    onSuccess: () => {
      toast.success(t("roleDeleted", { name: role.name }));
      void queryClient.invalidateQueries({ queryKey: ["roles"] });
      onClose();
    },
    onError: (e) => setProblem(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t("deleteRoleTitle", { name: role.name })}</DialogTitle>
          <DialogDescription>
            {inUse ? t("deleteRoleInUse", { count: role.userCount }) : t("deleteRoleBody")}
          </DialogDescription>
        </DialogHeader>
        {problem ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {problem}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          {inUse ? null : (
            <Button variant="destructive" loading={remove.isPending} onClick={() => remove.mutate()}>
              {t("deleteRoleConfirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RolesMatrix({ roles, permissions }: { roles: Role[]; permissions: PermissionInfo[] }) {
  const t = useTranslations("team");
  const matrix = permissionMatrix(permissions, roles);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-text-700">{t("rolesNote")}</p>
      <Card className="gap-0 py-0">
        <div className="overflow-x-auto">
          <Table scrollLabel={t("matrixLabel")}>
            <TableHeader className="bg-surface-2">
              <TableRow>
                <TableHead className="min-w-64">{t("colPermission")}</TableHead>
                {roles.map((r) => (
                  <TableHead key={r.id} className="text-center whitespace-nowrap">
                    {r.name}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {matrix.flatMap((m) => [
                <TableRow key={`m-${m.module}`} className="bg-surface-2/60">
                  <TableCell
                    colSpan={roles.length + 1}
                    className="text-[13px] font-semibold tracking-wide text-text-700 uppercase"
                  >
                    <ModuleName module={m.module} />
                  </TableCell>
                </TableRow>,
                ...m.rows.map((row) => (
                  <TableRow key={row.code}>
                    <TableCell>
                      <div className="grid gap-0.5">
                        <span className="text-sm text-text-900">{row.description ?? row.code}</span>
                        <span className="font-mono text-[12px] text-text-500">{row.code}</span>
                      </div>
                    </TableCell>
                    {roles.map((r) => (
                      <TableCell key={r.id} className="text-center">
                        {row.byRole[r.id] ? (
                          <>
                            <Check className="inline size-4 text-success" aria-hidden />
                            <span className="sr-only">{t("has", { role: r.name })}</span>
                          </>
                        ) : (
                          <>
                            <span className="text-text-disabled" aria-hidden>
                              —
                            </span>
                            <span className="sr-only">{t("hasNot", { role: r.name })}</span>
                          </>
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                )),
              ])}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
