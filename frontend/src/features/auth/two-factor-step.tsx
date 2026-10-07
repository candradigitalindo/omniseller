"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner } from "@/components/common/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { CodeInput } from "./code-input";

type Me = components["schemas"]["MeDto_Output"];

/**
 * L49, the second step of a login with two-step verification (backend doc 8.30): the 6 digits of the
 * authenticator app, or a backup code. The challenge from the password step lasts 5 minutes and 5 codes;
 * when it is gone, or too many wrong codes locked the account, the user starts again from the password.
 */
export function TwoFactorStep({
  challenge,
  onSignedIn,
  onRestart,
}: {
  challenge: string;
  onSignedIn: (me: Me, usedBackupCode: boolean) => void;
  onRestart: (message?: string) => void;
}) {
  const t = useTranslations("auth");
  const [mode, setMode] = useState<"app" | "backup">("app");
  const [code, setCode] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [error, setError] = useState<string | undefined>();

  const verify = useMutation({
    mutationFn: (factor: { code: string } | { backupCode: string }) =>
      unwrap(api.POST("/v1/auth/login/two-factor", { body: { challenge, ...factor } })),
    onSuccess: (me, factor) => onSignedIn(me, "backupCode" in factor),
    onError: (e) => {
      if (e instanceof ApiError && (e.code === "auth.two_factor_expired" || e.code === "auth.locked")) {
        onRestart(errorMessage(e));
        return;
      }
      setCode("");
      setError(errorMessage(e));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (verify.isPending) return;
    if (mode === "app") {
      if (code.length !== 6) return setError(t("codeIncomplete"));
      verify.mutate({ code });
    } else {
      if (backupCode.trim() === "") return setError(t("backupRequired"));
      verify.mutate({ backupCode: backupCode.trim() });
    }
  };
  const switchMode = () => {
    setMode(mode === "app" ? "backup" : "app");
    setError(undefined);
  };

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-bold text-text-900">{t("twoFactorTitle")}</h1>
        <p className="text-text-500">{mode === "app" ? t("twoFactorBody") : t("twoFactorBackupBody")}</p>
      </div>
      <form className="grid gap-4" noValidate onSubmit={submit}>
        {mode === "app" ? (
          <div className="grid gap-1.5">
            <Label htmlFor="code" className="text-sm font-medium text-text-700">
              {t("twoFactorCode")}
            </Label>
            <CodeInput
              id="code"
              value={code}
              onChange={(v) => {
                setCode(v);
                if (error) setError(undefined);
              }}
              // a complete code goes at once: no need to reach for the button
              onComplete={(v) => !verify.isPending && verify.mutate({ code: v })}
              invalid={!!error}
              describedBy={error ? "two-factor-error" : undefined}
              autoFocus
              disabled={verify.isPending}
            />
          </div>
        ) : (
          <Field id="backupCode" label={t("backupCode")}>
            <Input
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="xxxxx-xxxxx"
              className="font-mono"
              value={backupCode}
              onChange={(e) => {
                setBackupCode(e.target.value);
                if (error) setError(undefined);
              }}
              {...fieldProps("backupCode", undefined)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "two-factor-error" : undefined}
            />
          </Field>
        )}
        <div id="two-factor-error">
          <FormBanner message={error} />
        </div>
        <Button type="submit" size="lg" className="w-full md:h-10 md:text-[15px]" loading={verify.isPending}>
          {t("verify")}
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={switchMode}>
            {mode === "app" ? t("useBackupCode") : t("useAppCode")}
          </button>
          <button
            type="button"
            className="text-sm font-medium text-text-500 hover:text-text-700 hover:underline"
            onClick={() => onRestart()}
          >
            {t("backToLogin")}
          </button>
        </div>
      </form>
    </div>
  );
}
