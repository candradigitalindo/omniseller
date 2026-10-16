"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner, showServerErrors } from "@/components/common/form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, unwrap } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { meQueryKey } from "@/lib/session";
import { siteUrl } from "@/lib/site";
import { PasswordHint } from "./password-hint";

/** A document of the public site, opened beside the form; its name alone where there is no site. */
function legalLink(path: string) {
  const href = siteUrl(path);
  return (chunks: React.ReactNode) =>
    href ? (
      <a href={href} target="_blank" rel="noopener" className="font-medium text-primary hover:underline">
        {chunks}
      </a>
    ) : (
      chunks
    );
}

/** L49 Daftar: a business, its Owner, and a first warehouse in one step (backend `POST /v1/auth/signup`). */
export function SignupForm() {
  const t = useTranslations("auth");
  const common = useTranslations("common");
  const router = useRouter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);

  const schema = z.object({
    businessName: z.string().trim().min(2, t("required")).max(80, t("tooLong")),
    name: z.string().trim().min(1, t("required")).max(80, t("tooLong")),
    email: z.email(t("emailInvalid")).max(254, t("tooLong")),
    password: z.string().min(10, t("passwordTooShort")).max(128, t("tooLong")),
    agree: z.literal(true, { error: t("agreeRequired") }),
  });
  type Values = z.input<typeof schema>;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { businessName: "", name: "", email: "", password: "", agree: false as unknown as true },
  });
  const password = useWatch({ control: form.control, name: "password" }) ?? "";

  const signup = useMutation({
    mutationFn: ({ agree: _agree, ...body }: Values) => unwrap(api.POST("/v1/auth/signup", { body })),
    onSuccess: (me) => {
      queryClient.setQueryData(meQueryKey, me);
      router.replace("/");
    },
    onError: (error) => {
      showServerErrors(form, error);
      if (error instanceof ApiError && error.errors.some((e) => e.path === "businessName" || e.path === "name"))
        setStep(1);
    },
  });

  const { errors } = form.formState;

  return (
    <div className="grid gap-4 sm:gap-5">
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-bold text-text-900">{t("signupTitle")}</h1>
        <p className="hidden text-text-500 sm:block">{t("signupSubtitle")}</p>
      </div>
      <div role="status" className="grid grid-cols-3 gap-2" aria-label={t("stepOf", { step })}>
        {[1, 2, 3].map((number) => (
          <div key={number} className="grid gap-1.5">
            <span className={`h-1 rounded-full ${step >= number ? "bg-primary" : "bg-border"}`} />
            <span className={`text-[11px] font-medium ${step === number ? "text-primary" : "text-text-500"}`}>
              {number}. {t(number === 1 ? "stepProfileShort" : number === 2 ? "stepAccountShort" : "stepReview")}
            </span>
          </div>
        ))}
      </div>
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(e) => {
          if (step === 1) {
            e.preventDefault();
            void form.trigger(["businessName", "name"], { shouldFocus: true }).then((valid) => {
              if (valid) setStep(2);
            });
          } else if (step === 2) {
            e.preventDefault();
            void form.trigger(["email", "password"], { shouldFocus: true }).then((valid) => {
              if (valid) setStep(3);
            });
          } else void form.handleSubmit((values) => signup.mutate(values))(e);
        }}
      >
        <FormBanner message={errors.root?.message} onDismiss={() => form.clearErrors("root")} />
        <fieldset hidden={step !== 1} disabled={signup.isPending} className="grid gap-4 [hidden]:hidden">
          <Field
            id="businessName"
            label={t("businessName")}
            hint={<span className="hidden sm:inline">{t("businessNameHint")}</span>}
            error={errors.businessName?.message}
          >
            <Input
              autoComplete="organization"
              {...fieldProps("businessName", errors.businessName?.message, true)}
              {...form.register("businessName")}
            />
          </Field>
          <Field id="name" label={t("yourName")} error={errors.name?.message}>
            <Input autoComplete="name" {...fieldProps("name", errors.name?.message)} {...form.register("name")} />
          </Field>
        </fieldset>
        <fieldset hidden={step !== 2} disabled={signup.isPending} className="grid gap-4 [hidden]:hidden">
          <Field id="email" label={t("email")} error={errors.email?.message}>
            <Input
              type="email"
              autoComplete="email"
              inputMode="email"
              {...fieldProps("email", errors.email?.message)}
              {...form.register("email")}
            />
          </Field>
          <Field
            id="password"
            label={t("password")}
            hint={<PasswordHint password={password} />}
            error={errors.password?.message}
          >
            <Input
              type="password"
              autoComplete="new-password"
              {...fieldProps("password", errors.password?.message, true)}
              {...form.register("password")}
            />
          </Field>
        </fieldset>
        <fieldset hidden={step !== 3} disabled={signup.isPending} className="grid gap-4">
          <div className="grid gap-2 rounded-xl border bg-surface-2 p-3 text-sm">
            <p className="font-semibold text-text-900">{form.getValues("businessName")}</p>
            <p className="break-all text-text-500">{form.getValues("email")}</p>
          </div>
          <div className="grid gap-1.5">
            <div className="flex items-start gap-2">
              <Controller
                control={form.control}
                name="agree"
                render={({ field }) => (
                  <Checkbox
                    id="agree"
                    checked={field.value === true}
                    onCheckedChange={(v) => field.onChange(v === true)}
                    aria-invalid={errors.agree ? true : undefined}
                    className="mt-0.5"
                  />
                )}
              />
              <Label htmlFor="agree" className="block leading-snug font-normal text-text-700">
                {t.rich("agree", { terms: legalLink("/syarat-layanan/"), privacy: legalLink("/kebijakan-privasi/") })}
              </Label>
            </div>
            {errors.agree ? (
              <p role="alert" className="text-sm text-danger">
                {errors.agree.message}
              </p>
            ) : null}
          </div>
        </fieldset>
        <div className="flex gap-2">
          {step > 1 ? (
            <Button
              type="button"
              size="lg"
              variant="secondary"
              disabled={signup.isPending}
              onClick={() => setStep((s) => s - 1)}
            >
              {common("back")}
            </Button>
          ) : null}
          <Button
            type="submit"
            size="lg"
            className="flex-1"
            loading={signup.isPending}
            loadingLabel={t("signupProgress")}
          >
            {step < 3 ? common("continue") : t("signup")}
          </Button>
        </div>
      </form>
      <p className="text-sm text-text-500">
        {t("haveAccount")}{" "}
        <Link href="/masuk" className="font-medium text-primary hover:underline">
          {t("loginLink")}
        </Link>
      </p>
    </div>
  );
}
