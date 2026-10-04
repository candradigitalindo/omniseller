"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner, showServerErrors } from "@/components/common/form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, unwrap } from "@/lib/api/client";
import { meQueryKey } from "@/lib/session";
import { passwordStrength } from "./shared";

/** L49 Daftar: a business, its Owner, and a first warehouse in one step (backend `POST /v1/auth/signup`). */
export function SignupForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const queryClient = useQueryClient();

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
  const strength = passwordStrength(password);

  const signup = useMutation({
    mutationFn: ({ agree: _agree, ...body }: Values) => unwrap(api.POST("/v1/auth/signup", { body })),
    onSuccess: (me) => {
      queryClient.setQueryData(meQueryKey, me);
      router.replace("/");
    },
    onError: (error) => showServerErrors(form, error),
  });

  const { errors } = form.formState;
  const strengthLabel = { weak: t("strengthWeak"), fair: t("strengthFair"), strong: t("strengthStrong") }[strength];

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-bold text-text-900">{t("signupTitle")}</h1>
        <p className="text-text-500">{t("signupSubtitle")}</p>
      </div>
      <form className="grid gap-4" noValidate onSubmit={form.handleSubmit((values) => signup.mutate(values))}>
        <FormBanner message={errors.root?.message} />
        <Field
          id="businessName"
          label={t("businessName")}
          hint={t("businessNameHint")}
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
          hint={
            password ? (
              <span className="flex items-center gap-2">
                <span aria-hidden className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className={cn(
                        "h-1.5 w-8 rounded-full bg-border",
                        i === 0 && "bg-danger",
                        i === 1 && strength !== "weak" && "bg-warning",
                        i === 2 && strength === "strong" && "bg-success",
                      )}
                    />
                  ))}
                </span>
                {t("strength", { level: strengthLabel })}
              </span>
            ) : (
              t("passwordHint")
            )
          }
          error={errors.password?.message}
        >
          <Input
            type="password"
            autoComplete="new-password"
            {...fieldProps("password", errors.password?.message, true)}
            {...form.register("password")}
          />
        </Field>
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
            <Label htmlFor="agree" className="leading-snug font-normal text-text-700">
              {t("agree")}
            </Label>
          </div>
          {errors.agree ? (
            <p role="alert" className="text-sm text-danger">
              {errors.agree.message}
            </p>
          ) : null}
        </div>
        <Button type="submit" size="lg" className="w-full md:h-10 md:text-[15px]" loading={signup.isPending}>
          {t("signup")}
        </Button>
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
