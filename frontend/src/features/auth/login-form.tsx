"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner, showServerErrors } from "@/components/common/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { api, unwrap } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { meQueryKey } from "@/lib/session";
import { safeNext } from "./shared";

type Tenant = { slug: string; name: string };

/**
 * L49 Masuk. An email registered in several businesses gets 409 `auth.tenant_choice_required` with the
 * businesses; the user picks one and the same request goes again with `tenant` (backend doc 8.10).
 */
export function LoginForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [tenant, setTenant] = useState<string>("");

  const schema = z.object({
    email: z.email(t("emailInvalid")).max(254, t("tooLong")),
    password: z.string().min(1, t("required")).max(128, t("tooLong")),
  });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  const login = useMutation({
    mutationFn: (values: Values) =>
      unwrap(api.POST("/v1/auth/login", { body: { ...values, ...(tenant ? { tenant } : {}) } })),
    onSuccess: (me) => {
      queryClient.setQueryData(meQueryKey, me);
      router.replace(safeNext(params.get("next")));
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "auth.tenant_choice_required") {
        const list = (error.problem.tenants as Tenant[] | undefined) ?? [];
        setTenants(list);
        setTenant(list[0]?.slug ?? "");
        return;
      }
      showServerErrors(form, error);
    },
  });

  const { errors } = form.formState;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-bold text-text-900">{t("loginTitle")}</h1>
        <p className="text-text-500">{t("loginSubtitle")}</p>
      </div>
      <form className="grid gap-4" noValidate onSubmit={form.handleSubmit((values) => login.mutate(values))}>
        <FormBanner message={errors.root?.message} />
        <Field id="email" label={t("email")} error={errors.email?.message}>
          <Input
            type="email"
            autoComplete="username"
            inputMode="email"
            {...fieldProps("email", errors.email?.message)}
            {...form.register("email")}
          />
        </Field>
        <Field id="password" label={t("password")} error={errors.password?.message}>
          <Input
            type="password"
            autoComplete="current-password"
            {...fieldProps("password", errors.password?.message)}
            {...form.register("password")}
          />
        </Field>
        {tenants ? (
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm text-text-700">{t("chooseBusiness")}</legend>
            <RadioGroup value={tenant} onValueChange={setTenant} aria-label={t("business")}>
              {tenants.map((b) => (
                <div key={b.slug} className="flex items-center gap-2">
                  <RadioGroupItem value={b.slug} id={`tenant-${b.slug}`} />
                  <Label htmlFor={`tenant-${b.slug}`} className="font-normal">
                    {b.name}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
        ) : null}
        <Button type="submit" size="lg" className="w-full md:h-10 md:text-[15px]" loading={login.isPending}>
          {t("login")}
        </Button>
        <Link href="/lupa-sandi" className="justify-self-start text-sm font-medium text-primary hover:underline">
          {t("forgotPassword")}
        </Link>
      </form>
      <p className="text-sm text-text-500">
        {t("noAccount")}{" "}
        <Link href="/daftar" className="font-medium text-primary hover:underline">
          {t("signupLink")}
        </Link>
      </p>
    </div>
  );
}
