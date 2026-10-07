"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Building2, Info, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorState, PageHeader } from "@/components/common/page";
import { Segmented } from "@/components/common/segmented";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { fileToBase64 } from "@/lib/file";
import { formatDate } from "@/lib/format";
import { PROVINCES } from "@/lib/region";
import { meQueryKey, useCan } from "@/lib/session";
import {
  type BusinessProfile,
  draftOf,
  LOGO_TYPES,
  MAX_LOGO_BYTES,
  type NibMode,
  type ProfileDraft,
  type ProfileField,
  patchOf,
  problemsOf,
  TIMEZONES,
} from "./business-meta";
import { DocumentsCard } from "./documents-card";

export const profileKey = ["business", "profile"] as const;

/**
 * Profil Bisnis & Legalitas (UI L47; PRD 6.13 and 12, Permendag 19/2026): the business's name, address,
 * and logo, its NIB (or the NIB it is getting, six months at most), NPWP, PKP status, and legal documents
 * with how long they are valid. The Owner's (settings:billing).
 */
export function BusinessProfileView() {
  const t = useTranslations("business");
  const can = useCan();
  const allowed = can("settings:billing");
  const profile = useQuery({
    queryKey: profileKey,
    queryFn: () => unwrap(api.GET("/v1/business-profile")),
    enabled: allowed,
  });
  if (!allowed) return <PageHeader title={t("title")} description={t("noAccess")} />;
  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      {profile.isPending ? (
        <div className="grid gap-4" aria-busy>
          <Skeleton className="h-16" />
          <Skeleton className="h-96" />
        </div>
      ) : profile.isError ? (
        <ErrorState error={profile.error} onRetry={() => profile.refetch()} />
      ) : (
        <Loaded profile={profile.data} />
      )}
    </>
  );
}

function Loaded({ profile: p }: { profile: BusinessProfile }) {
  return (
    <div className="grid gap-4">
      <NibBanner profile={p} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <ProfileForm profile={p} />
        <LogoCard profile={p} />
      </div>
      <DocumentsCard profile={p} />
    </div>
  );
}

/** Permendag 19/2026: a seller needs an NIB, or one being made for at most six months. */
function NibBanner({ profile: p }: { profile: BusinessProfile }) {
  const t = useTranslations("business");
  const tz = p.timezone;
  if (p.nibStatus === "registered") return null;
  const passed = p.nibStatus === "in_process" && (p.nibDaysLeft ?? 0) < 0;
  const soon = p.nibStatus === "in_process" && !passed && (p.nibDaysLeft ?? 99) <= 30;
  const tone = p.nibStatus === "missing" || soon ? "warning" : passed ? "danger" : "info";
  const Icon = tone === "info" ? Info : AlertTriangle;
  const text =
    p.nibStatus === "missing"
      ? t("nibMissing")
      : passed
        ? t("nibPassed", { deadline: formatDate(p.nibDeadline!, tz) })
        : t("nibInProcess", {
            since: formatDate(p.nibInProcessSince!, tz),
            deadline: formatDate(p.nibDeadline!, tz),
            days: p.nibDaysLeft ?? 0,
          });
  const colors = {
    warning: "bg-warning-soft text-text-900",
    danger: "bg-danger-soft text-text-900",
    info: "bg-primary-50 text-text-900",
  }[tone];
  return (
    <div role="status" className={`flex items-start gap-2 rounded-[10px] px-4 py-3 text-sm ${colors}`}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>{text}</p>
    </div>
  );
}

const FIELD_IDS: Record<ProfileField, string> = {
  name: "biz-name",
  postalCode: "biz-postal",
  phone: "biz-phone",
  nib: "biz-nib",
  nibInProcessSince: "biz-nib-since",
  npwp: "biz-npwp",
};

function ProfileForm({ profile: p }: { profile: BusinessProfile }) {
  const t = useTranslations("business");
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ProfileDraft>(() => draftOf(p));
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Partial<Record<string, string>>>({});
  const set = (patch: Partial<ProfileDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const problems = problemsOf(draft, p.today);
  const patch = patchOf(draft, p);
  const changed = Object.keys(patch).length > 0;
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/v1/business-profile", {
          body: patch,
          headers: { "If-Match": `"${p.rowVersion}"` },
        }),
      ),
    onSuccess: (next) => {
      queryClient.setQueryData(profileKey, next);
      // the form goes on from what was saved; a logo or a document changed meanwhile leaves typing alone
      setDraft(draftOf(next));
      setTried(false);
      if (patch.name !== undefined || patch.timezone !== undefined) {
        void queryClient.invalidateQueries({ queryKey: meQueryKey });
      }
      toast.success(t("saved"));
    },
    onError: (error) => {
      if (error instanceof ApiError && error.errors.length > 0) {
        setServer(Object.fromEntries(error.errors.map((e) => [e.path.split(".")[0], e.message])));
      }
      toast.error(errorMessage(error));
    },
  });
  // a problem shows once a save was tried, or as soon as something typed in the field is wrong
  const problem = (field: ProfileField) => {
    const found = problems[field];
    return server[field] ?? (found && (tried || draft[field].trim() !== "") ? t(`problem_${found}`) : undefined);
  };
  const field = (id: ProfileField) => {
    const message = problem(id);
    return {
      id: FIELD_IDS[id],
      "aria-invalid": message ? true : undefined,
      "aria-describedby": message ? `${FIELD_IDS[id]}-message` : undefined,
    } as const;
  };
  const message = (id: ProfileField) => {
    const m = problem(id);
    return m ? (
      <p id={`${FIELD_IDS[id]}-message`} className="text-[13px] text-danger">
        {m}
      </p>
    ) : null;
  };

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        setServer({});
        if (Object.keys(problems).length === 0 && changed) save.mutate();
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("profileTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor={FIELD_IDS.name}>{t("name")}</Label>
            <Input
              value={draft.name}
              maxLength={80}
              onChange={(e) => set({ name: e.target.value })}
              {...field("name")}
            />
            {message("name")}
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="biz-line1">{t("line1")}</Label>
            <Input
              id="biz-line1"
              value={draft.line1}
              maxLength={200}
              onChange={(e) => set({ line1: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="biz-district">{t("district")}</Label>
            <Input
              id="biz-district"
              value={draft.district}
              maxLength={80}
              onChange={(e) => set({ district: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="biz-city">{t("city")}</Label>
            <Input id="biz-city" value={draft.city} maxLength={80} onChange={(e) => set({ city: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="biz-province">{t("province")}</Label>
            <Select value={draft.province} onValueChange={(v) => set({ province: v })}>
              <SelectTrigger id="biz-province" className="w-full">
                <SelectValue placeholder={t("chooseProvince")} />
              </SelectTrigger>
              <SelectContent>
                {PROVINCES.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={FIELD_IDS.postalCode}>{t("postalCode")}</Label>
            <Input
              inputMode="numeric"
              value={draft.postalCode}
              maxLength={5}
              onChange={(e) => set({ postalCode: e.target.value })}
              {...field("postalCode")}
            />
            {message("postalCode")}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={FIELD_IDS.phone}>{t("phone")}</Label>
            <Input
              type="tel"
              inputMode="tel"
              value={draft.phone}
              maxLength={20}
              onChange={(e) => set({ phone: e.target.value })}
              {...field("phone")}
            />
            {message("phone")}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="biz-timezone">{t("timezone")}</Label>
            <Select value={draft.timezone} onValueChange={(v) => set({ timezone: v })}>
              <SelectTrigger id="biz-timezone" className="w-full" aria-describedby="biz-timezone-hint">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((z) => (
                  <SelectItem key={z.value} value={z.value}>
                    {t(`tz_${z.key}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id="biz-timezone-hint" className="text-[13px] text-text-500">
              {t("timezoneHint")}
            </p>
          </div>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium text-text-700">{t("currency")}</span>
            <p className="text-sm text-text-900">{t("rupiah")}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("legalTitle")}</h2>
          </CardTitle>
          <CardDescription>{t("legalBody")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5">
            <span className="text-sm font-medium text-text-700">{t("nib")}</span>
            <Segmented<NibMode>
              value={draft.nibMode}
              options={[
                { value: "registered", label: t("nibRegistered") },
                { value: "in_process", label: t("nibInProcessOption") },
                { value: "missing", label: t("nibNone") },
              ]}
              onChange={(v) => set({ nibMode: v })}
              label={t("nib")}
              block
            />
          </div>
          {draft.nibMode === "registered" ? (
            <div className="grid gap-1.5 sm:max-w-xs">
              <Label htmlFor={FIELD_IDS.nib}>{t("nibNumber")}</Label>
              <Input
                inputMode="numeric"
                className="font-mono"
                value={draft.nib}
                maxLength={20}
                onChange={(e) => set({ nib: e.target.value })}
                {...field("nib")}
              />
              {message("nib")}
            </div>
          ) : draft.nibMode === "in_process" ? (
            <div className="grid gap-1.5 sm:max-w-xs">
              <Label htmlFor={FIELD_IDS.nibInProcessSince}>{t("nibSince")}</Label>
              <Input
                type="date"
                max={p.today}
                value={draft.nibInProcessSince}
                onChange={(e) => set({ nibInProcessSince: e.target.value })}
                {...field("nibInProcessSince")}
              />
              {message("nibInProcessSince")}
              <p className="text-[13px] text-text-500">{t("nibSinceHint")}</p>
            </div>
          ) : null}
          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor={FIELD_IDS.npwp}>{t("npwp")}</Label>
            <Input
              inputMode="numeric"
              className="font-mono"
              value={draft.npwp}
              maxLength={24}
              onChange={(e) => set({ npwp: e.target.value })}
              {...field("npwp")}
            />
            {message("npwp")}
          </div>
          <div className="flex items-start justify-between gap-4">
            <span className="grid gap-0.5">
              <Label htmlFor="biz-pkp">{t("pkp")}</Label>
              <span id="biz-pkp-hint" className="text-[13px] text-text-500">
                {t("pkpHint")}
              </span>
            </span>
            <Switch
              id="biz-pkp"
              checked={draft.pkp}
              onCheckedChange={(v) => set({ pkp: v })}
              aria-describedby="biz-pkp-hint"
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!changed} loading={save.isPending}>
          {t("save")}
        </Button>
        {changed ? <span className="text-[13px] text-text-500">{t("unsaved")}</span> : null}
      </div>
    </form>
  );
}

/** The logo, a PNG, JPG, or WebP of at most 1 MB; shown at `/v1/business-profile/logo`. */
function LogoCard({ profile: p }: { profile: BusinessProfile }) {
  const t = useTranslations("business");
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) =>
      unwrap(api.PUT("/v1/business-profile/logo", { body: { content: await fileToBase64(file) } })),
    onSuccess: (next) => {
      queryClient.setQueryData(profileKey, next);
      toast.success(t("logoSaved"));
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/business-profile/logo")),
    onSuccess: (next) => {
      queryClient.setQueryData(profileKey, next);
      toast.success(t("logoRemoved"));
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("logoTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("logoBody")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid h-32 place-items-center rounded-lg border bg-surface-2">
          {p.hasLogo ? (
            // the version in the address shows a replaced logo at once
            // biome-ignore lint/performance/noImgElement: a private file behind the session, not a static asset
            <img
              src={`/v1/business-profile/logo?v=${p.rowVersion}`}
              alt={t("logoAlt", { name: p.name })}
              className="max-h-28 max-w-full object-contain"
            />
          ) : (
            <Building2 className="size-10 text-text-300" aria-hidden />
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept={LOGO_TYPES}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (file.size > MAX_LOGO_BYTES || !LOGO_TYPES.split(",").includes(file.type)) {
              toast.error(t("logoInvalid"));
              return;
            }
            upload.mutate(file);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" loading={upload.isPending} onClick={() => input.current?.click()}>
            <Upload aria-hidden />
            {p.hasLogo ? t("logoReplace") : t("logoUpload")}
          </Button>
          {p.hasLogo ? (
            <Button variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate()}>
              {t("logoRemove")}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
