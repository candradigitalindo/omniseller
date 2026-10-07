"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, ShieldCheck, ShieldOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner } from "@/components/common/form";
import { ErrorState, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CodeInput } from "@/features/auth/code-input";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { formatDate } from "@/lib/format";
import { meQueryKey, useSession, useTimeZone } from "@/lib/session";
import {
  backupCodesText,
  groupSecret,
  LOW_BACKUP_CODES,
  qrDataUrl,
  sessionsQueryKey,
  twoFactorQueryKey,
} from "./security-meta";

type Setup = components["schemas"]["TwoFactorSetupDto_Output"];

/**
 * "Verifikasi dua langkah" on Akun saya (UI L41b, PRD FR-USR-05, backend doc 8.30): turning it on with an
 * authenticator app, new backup codes, and turning it off. Owner and Admin are urged to turn it on.
 */
export function TwoFactorCard() {
  const t = useTranslations("account");
  const tz = useTimeZone();
  const [dialog, setDialog] = useState<"enable" | "codes" | "disable" | null>(null);
  const status = useQuery({ queryKey: twoFactorQueryKey, queryFn: () => unwrap(api.GET("/v1/me/two-factor")) });
  const close = () => setDialog(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("twoFactorTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("twoFactorBody")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {status.isPending ? (
          <Skeleton className="h-20" />
        ) : status.isError ? (
          <ErrorState error={status.error} onRetry={() => status.refetch()} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {status.data.enabled ? (
                <StatusPill tone="success" icon={ShieldCheck}>
                  {t("twoFactorOn")}
                </StatusPill>
              ) : (
                <StatusPill tone="neutral" icon={ShieldOff}>
                  {t("twoFactorOff")}
                </StatusPill>
              )}
              {status.data.enabled && status.data.enabledAt ? (
                <span className="text-sm text-text-500">
                  {t("twoFactorSince", { date: formatDate(status.data.enabledAt, tz) })}
                </span>
              ) : null}
            </div>
            {!status.data.enabled && status.data.recommended ? (
              <p className="rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-text-900">
                {t("twoFactorRecommended")}
              </p>
            ) : null}
            {status.data.enabled ? (
              <div className="grid gap-1 text-sm">
                <span className="text-text-700">{t("backupLeft", { count: status.data.backupCodesLeft })}</span>
                {status.data.backupCodesLeft <= LOW_BACKUP_CODES ? (
                  <span className="text-warning">{t("backupLow")}</span>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {status.data.enabled ? (
                <>
                  <Button variant="secondary" onClick={() => setDialog("codes")}>
                    {t("newBackupCodes")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-danger hover:text-danger"
                    onClick={() => setDialog("disable")}
                  >
                    {t("disable")}
                  </Button>
                </>
              ) : (
                <Button onClick={() => setDialog("enable")}>{t("enable")}</Button>
              )}
            </div>
          </>
        )}
      </CardContent>
      <EnableDialog open={dialog === "enable"} onClose={close} />
      <RegenerateDialog open={dialog === "codes"} onClose={close} />
      <DisableDialog open={dialog === "disable"} onClose={close} />
    </Card>
  );
}

/** Refreshes what turning it on or off changes: this card, the session, and the device list. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: twoFactorQueryKey });
    void queryClient.invalidateQueries({ queryKey: meQueryKey });
    void queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
  };
}

/** Password, then the QR code and a code from the app, then the backup codes (shown once). */
function EnableDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("account");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const reset = () => {
    setSetup(null);
    setCodes(null);
    onClose();
  };
  return (
    // the backup codes are shown once: the dialog closes only through "Selesai"
    <Dialog open={open} onOpenChange={(v) => !v && !codes && reset()}>
      <DialogContent className="sm:max-w-[480px]" showCloseButton={!codes}>
        {codes ? (
          <BackupCodes codes={codes} title={t("backupTitle")} onDone={reset} />
        ) : setup ? (
          <ConfirmCode setup={setup} onEnabled={setCodes} onCancel={reset} />
        ) : (
          <PasswordStep
            title={t("enableTitle")}
            body={t("enablePasswordBody")}
            onCancel={reset}
            send={(password) => unwrap(api.POST("/v1/me/two-factor/setup", { body: { password } }))}
            onDone={setSetup}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Asks the password, sends it, and passes the answer on; a wrong password shows on its field. */
function PasswordStep<T>({
  title,
  body,
  send,
  onDone,
  onCancel,
}: {
  title: string;
  body: string;
  send: (password: string) => Promise<T>;
  onDone: (result: T) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("account");
  const me = useSession();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<{ field?: string; banner?: string }>({});
  const go = useMutation({
    mutationFn: send,
    onSuccess: onDone,
    onError: (e) => {
      const issue = e instanceof ApiError ? e.errors.find((i) => i.path === "password") : undefined;
      setError(issue ? { field: issue.message } : { banner: errorMessage(e) });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password === "") return setError({ field: t("passwordRequired") });
    go.mutate(password);
  };
  return (
    <form className="grid gap-4" noValidate onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{body}</DialogDescription>
      </DialogHeader>
      {/* lets password managers offer the saved password of this account */}
      <input type="email" autoComplete="username" value={me.user.email} readOnly hidden />
      <FormBanner message={error.banner} />
      <Field id="confirm-password" label={t("password")} error={error.field}>
        <Input
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError({});
          }}
          {...fieldProps("confirm-password", error.field)}
        />
      </Field>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" loading={go.isPending}>
          {t("continue")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ConfirmCode({
  setup,
  onEnabled,
  onCancel,
}: {
  setup: Setup;
  onEnabled: (codes: string[]) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("account");
  const refresh = useRefresh();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const enable = useMutation({
    mutationFn: (value: string) => unwrap(api.POST("/v1/me/two-factor/enable", { body: { code: value } })),
    onSuccess: (r) => {
      refresh();
      toast.success(t("enabled"));
      onEnabled(r.backupCodes);
    },
    onError: (e) => {
      setCode("");
      setError(
        e instanceof ApiError ? (e.errors.find((i) => i.path === "code")?.message ?? errorMessage(e)) : errorMessage(e),
      );
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return setError(t("codeIncomplete"));
    enable.mutate(code);
  };
  return (
    <form className="grid gap-4" noValidate onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{t("enableTitle")}</DialogTitle>
        <DialogDescription>{t("scanBody")}</DialogDescription>
      </DialogHeader>
      <div className="grid justify-items-center gap-3">
        {/* white behind the code in both themes, so phone cameras read it */}
        {/* biome-ignore lint/performance/noImgElement: a QR code drawn for this setup, not a static asset */}
        <img src={qrDataUrl(setup.qrSvg)} alt={t("qrAlt")} className="size-44 rounded-lg border bg-white p-2" />
        <div className="grid gap-1 text-center">
          <span className="text-sm text-text-500">{t("manualKey")}</span>
          <code className="select-all break-all font-mono text-sm font-semibold tracking-wide text-text-900">
            {groupSecret(setup.secret)}
          </code>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="enable-code" className="text-sm font-medium text-text-700">
          {t("codeLabel")}
        </Label>
        <CodeInput
          id="enable-code"
          value={code}
          onChange={(v) => {
            setCode(v);
            setError(undefined);
          }}
          onComplete={(v) => !enable.isPending && enable.mutate(v)}
          invalid={!!error}
          describedBy={error ? "enable-code-error" : undefined}
          disabled={enable.isPending}
        />
        <div id="enable-code-error">
          <FormBanner message={error} />
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" loading={enable.isPending}>
          {t("enableConfirm")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The backup codes, once: copy or download them, and say they are kept before closing. */
function BackupCodes({ codes, title, onDone }: { codes: string[]; title: string; onDone: () => void }) {
  const t = useTranslations("account");
  const me = useSession();
  const [kept, setKept] = useState(false);
  const text = backupCodesText(codes, t("codesFileTitle", { email: me.user.email }), t("codesFileNote"));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "omniseller-kode-cadangan.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t("backupBody")}</DialogDescription>
      </DialogHeader>
      <ul
        aria-label={t("backupListLabel")}
        className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border bg-surface-2 px-4 py-3 font-mono text-[15px] text-text-900"
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={copy}>
          <Copy aria-hidden />
          {t("copyCodes")}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={download}>
          <Download aria-hidden />
          {t("downloadCodes")}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="codes-kept" checked={kept} onCheckedChange={(v) => setKept(v === true)} />
        <Label htmlFor="codes-kept" className="font-normal">
          {t("savedCodes")}
        </Label>
      </div>
      <DialogFooter>
        <Button type="button" disabled={!kept} onClick={onDone}>
          {t("done")}
        </Button>
      </DialogFooter>
    </div>
  );
}

function RegenerateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("account");
  const refresh = useRefresh();
  const [codes, setCodes] = useState<string[] | null>(null);
  const reset = () => {
    setCodes(null);
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !v && !codes && reset()}>
      <DialogContent className="sm:max-w-[480px]" showCloseButton={!codes}>
        {codes ? (
          <BackupCodes codes={codes} title={t("backupTitle")} onDone={reset} />
        ) : (
          <PasswordStep
            title={t("regenerateTitle")}
            body={t("regenerateBody")}
            onCancel={reset}
            send={(password) => unwrap(api.POST("/v1/me/two-factor/backup-codes", { body: { password } }))}
            onDone={(r) => {
              refresh();
              setCodes(r.backupCodes);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Turning it off takes the password and a code from the app or a backup code. */
function DisableDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[480px]">{open ? <DisableForm onClose={onClose} /> : null}</DialogContent>
    </Dialog>
  );
}

function DisableForm({ onClose: close }: { onClose: () => void }) {
  const t = useTranslations("account");
  const me = useSession();
  const refresh = useRefresh();
  const [mode, setMode] = useState<"app" | "backup">("app");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [errors, setErrors] = useState<Partial<Record<"password" | "code" | "backupCode" | "banner", string>>>({});
  const disable = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/me/two-factor/disable", {
          body: { password, ...(mode === "app" ? { code } : { backupCode: backupCode.trim() }) },
        }),
      ),
    onSuccess: () => {
      refresh();
      toast.success(t("disabled"));
      close();
    },
    onError: (e) => {
      const next: typeof errors = {};
      if (e instanceof ApiError) {
        for (const i of e.errors) {
          if (i.path === "password" || i.path === "code" || i.path === "backupCode") next[i.path] = i.message;
        }
      }
      if (Object.keys(next).length === 0) next.banner = errorMessage(e);
      if (next.code) setCode("");
      setErrors(next);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (password === "") next.password = t("passwordRequired");
    if (mode === "app" && code.length !== 6) next.code = t("codeIncomplete");
    if (mode === "backup" && backupCode.trim() === "") next.backupCode = t("backupRequired");
    setErrors(next);
    if (Object.keys(next).length === 0) disable.mutate();
  };
  return (
    <form className="grid gap-4" noValidate onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{t("disableTitle")}</DialogTitle>
        <DialogDescription>{t("disableBody")}</DialogDescription>
      </DialogHeader>
      <input type="email" autoComplete="username" value={me.user.email} readOnly hidden />
      <FormBanner message={errors.banner} />
      <Field id="disable-password" label={t("password")} error={errors.password}>
        <Input
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          {...fieldProps("disable-password", errors.password)}
        />
      </Field>
      {mode === "app" ? (
        <div className="grid gap-1.5">
          <Label htmlFor="disable-code" className="text-sm font-medium text-text-700">
            {t("codeLabel")}
          </Label>
          <CodeInput
            id="disable-code"
            value={code}
            onChange={setCode}
            invalid={!!errors.code}
            describedBy={errors.code ? "disable-code-error" : undefined}
          />
          <div id="disable-code-error">
            <FormBanner message={errors.code} />
          </div>
        </div>
      ) : (
        <Field id="disable-backup" label={t("backupCode")} error={errors.backupCode}>
          <Input
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="xxxxx-xxxxx"
            className="font-mono"
            value={backupCode}
            onChange={(e) => setBackupCode(e.target.value)}
            {...fieldProps("disable-backup", errors.backupCode)}
          />
        </Field>
      )}
      <button
        type="button"
        className="justify-self-start text-sm font-medium text-primary hover:underline"
        onClick={() => {
          setMode(mode === "app" ? "backup" : "app");
          setErrors({});
        }}
      >
        {mode === "app" ? t("useBackupCode") : t("useAppCode")}
      </button>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={close}>
          {t("cancel")}
        </Button>
        <Button type="submit" variant="destructive" loading={disable.isPending}>
          {t("disableConfirm")}
        </Button>
      </DialogFooter>
    </form>
  );
}
