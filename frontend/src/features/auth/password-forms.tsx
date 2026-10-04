"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner, showServerErrors } from "@/components/common/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";

function Done({ message }: { message: string }) {
  const t = useTranslations("auth");
  return (
    <div className="grid gap-4">
      <div role="status" className="flex items-start gap-2 rounded-lg bg-success-soft px-3 py-2.5 text-sm text-success">
        <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{message}</span>
      </div>
      <Link href="/masuk" className="text-sm font-medium text-primary hover:underline">
        {t("backToLogin")}
      </Link>
    </div>
  );
}

/** "Lupa kata sandi": always the same answer, whether the email is registered or not (backend doc 8.10). */
export function ForgotPasswordForm() {
  const t = useTranslations("auth");
  const schema = z.object({ email: z.email(t("emailInvalid")).max(254, t("tooLong")) });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "" } });
  const request = useMutation({
    mutationFn: (body: Values) => unwrap(api.POST("/v1/auth/password-reset", { body })),
    onError: (error) => showServerErrors(form, error),
  });
  const { errors } = form.formState;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-bold text-text-900">{t("forgotTitle")}</h1>
        <p className="text-text-500">{t("forgotSubtitle")}</p>
      </div>
      {request.isSuccess ? (
        <Done message={t("forgotSent")} />
      ) : (
        <form className="grid gap-4" noValidate onSubmit={form.handleSubmit((values) => request.mutate(values))}>
          <FormBanner message={errors.root?.message} />
          <Field id="email" label={t("email")} error={errors.email?.message}>
            <Input
              type="email"
              autoComplete="email"
              inputMode="email"
              {...fieldProps("email", errors.email?.message)}
              {...form.register("email")}
            />
          </Field>
          <Button type="submit" size="lg" className="w-full md:h-10 md:text-[15px]" loading={request.isPending}>
            {t("sendLink")}
          </Button>
          <Link href="/masuk" className="justify-self-start text-sm font-medium text-primary hover:underline">
            {t("backToLogin")}
          </Link>
        </form>
      )}
    </div>
  );
}

/** The link from the reset email (`/atur-ulang-sandi?token=`): a new password, every session signed out. */
export function ResetPasswordForm() {
  const t = useTranslations("auth");
  const token = useSearchParams().get("token") ?? "";
  const schema = z
    .object({
      password: z.string().min(10, t("passwordTooShort")).max(128, t("tooLong")),
      confirm: z.string(),
    })
    .refine((v) => v.password === v.confirm, { path: ["confirm"], message: t("passwordMismatch") });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { password: "", confirm: "" } });
  const reset = useMutation({
    mutationFn: ({ password }: Values) =>
      unwrap(api.POST("/v1/auth/password-reset/confirm", { body: { token, password } })),
    onError: (error) => showServerErrors(form, error),
  });
  const { errors } = form.formState;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-bold text-text-900">{t("resetTitle")}</h1>
        <p className="text-text-500">{t("resetSubtitle")}</p>
      </div>
      {!token ? (
        <FormBanner message={t("missingToken")} />
      ) : reset.isSuccess ? (
        <Done message={t("resetDone")} />
      ) : (
        <form className="grid gap-4" noValidate onSubmit={form.handleSubmit((values) => reset.mutate(values))}>
          <FormBanner message={errors.root?.message} />
          <Field id="password" label={t("newPassword")} hint={t("passwordHint")} error={errors.password?.message}>
            <Input
              type="password"
              autoComplete="new-password"
              {...fieldProps("password", errors.password?.message, true)}
              {...form.register("password")}
            />
          </Field>
          <Field id="confirm" label={t("confirmPassword")} error={errors.confirm?.message}>
            <Input
              type="password"
              autoComplete="new-password"
              {...fieldProps("confirm", errors.confirm?.message)}
              {...form.register("confirm")}
            />
          </Field>
          <Button type="submit" size="lg" className="w-full md:h-10 md:text-[15px]" loading={reset.isPending}>
            {t("saveNewPassword")}
          </Button>
        </form>
      )}
    </div>
  );
}
