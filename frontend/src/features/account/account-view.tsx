"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner, showServerErrors } from "@/components/common/form";
import { PageHeader } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordHint } from "@/features/auth/password-hint";
import { api, unwrap } from "@/lib/api/client";
import { useSession } from "@/lib/session";
import { SessionsCard } from "./sessions-card";
import { TwoFactorCard } from "./two-factor-card";

/**
 * "Akun saya" (UI L41b), opened from the profile menu: who is signed in, changing the password (PRD
 * FR-USR-03; the api signs out every other session and keeps this one), two-step verification
 * (FR-USR-05), and the devices signed in (FR-USR-06).
 */
export function AccountView() {
  const t = useTranslations("account");
  const me = useSession();
  const rows: [string, string][] = [
    [t("name"), me.user.name],
    [t("email"), me.user.email],
    [t("business"), me.tenant.name],
    [t("roles"), me.roles.map((r) => r.name).join(", ")],
  ];
  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("profile")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-sm">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-text-500">{label}</dt>
                  <dd className="break-words text-text-900">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("passwordTitle")}</h2>
            </CardTitle>
            <CardDescription>{t("passwordBody")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm email={me.user.email} />
          </CardContent>
        </Card>
        <TwoFactorCard />
        <SessionsCard />
      </div>
    </>
  );
}

function ChangePasswordForm({ email }: { email: string }) {
  const t = useTranslations("account");
  const tAuth = useTranslations("auth");
  const schema = z
    .object({
      currentPassword: z.string().min(1, t("currentRequired")).max(128, tAuth("tooLong")),
      newPassword: z.string().min(10, tAuth("passwordTooShort")).max(128, tAuth("tooLong")),
      confirm: z.string(),
    })
    .refine((v) => v.newPassword === v.confirm, { path: ["confirm"], message: tAuth("passwordMismatch") })
    .refine((v) => v.newPassword !== v.currentPassword, { path: ["newPassword"], message: t("sameAsCurrent") });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", newPassword: "", confirm: "" },
  });
  const newPassword = useWatch({ control: form.control, name: "newPassword" }) ?? "";
  const change = useMutation({
    mutationFn: ({ currentPassword, newPassword }: Values) =>
      unwrap(api.POST("/v1/me/password", { body: { currentPassword, newPassword } })),
    onSuccess: () => {
      toast.success(t("saved"));
      form.reset();
    },
    // a wrong current password comes back on `currentPassword`
    onError: (error) => showServerErrors(form, error),
  });
  const { errors } = form.formState;

  return (
    <form className="grid gap-4" noValidate onSubmit={form.handleSubmit((values) => change.mutate(values))}>
      {/* lets password managers file the new password under this account */}
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      <FormBanner message={errors.root?.message} />
      <Field id="currentPassword" label={t("currentPassword")} error={errors.currentPassword?.message}>
        <Input
          type="password"
          autoComplete="current-password"
          {...fieldProps("currentPassword", errors.currentPassword?.message)}
          {...form.register("currentPassword")}
        />
      </Field>
      <Field
        id="newPassword"
        label={t("newPassword")}
        hint={<PasswordHint password={newPassword} />}
        error={errors.newPassword?.message}
      >
        <Input
          type="password"
          autoComplete="new-password"
          {...fieldProps("newPassword", errors.newPassword?.message, true)}
          {...form.register("newPassword")}
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
      <Button type="submit" className="justify-self-start" loading={change.isPending}>
        {t("save")}
      </Button>
    </form>
  );
}
