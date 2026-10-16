"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner, showServerErrors } from "@/components/common/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, unwrap } from "@/lib/api/client";
import { meQueryKey } from "@/lib/session";

/**
 * The link from an invitation email (`/undangan?token=`): shows the business and the role, then creates
 * the member with a name and a password and signs them in (backend `invitations/inspect`, `accept`).
 */
export function InvitationForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const queryClient = useQueryClient();
  const token = useSearchParams().get("token") ?? "";

  const preview = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => unwrap(api.POST("/v1/auth/invitations/inspect", { body: { token } })),
    enabled: token.length > 0,
    retry: false,
  });

  const schema = z.object({
    name: z.string().trim().min(1, t("required")).max(80, t("tooLong")),
    password: z.string().min(10, t("passwordTooShort")).max(128, t("tooLong")),
  });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: "", password: "" } });
  const accept = useMutation({
    mutationFn: (values: Values) => unwrap(api.POST("/v1/auth/invitations/accept", { body: { token, ...values } })),
    onSuccess: (me) => {
      queryClient.setQueryData(meQueryKey, me);
      router.replace("/");
    },
    onError: (error) => showServerErrors(form, error),
  });
  const { errors } = form.formState;

  if (!token) return <FormBanner message={t("missingToken")} />;
  if (preview.isPending) {
    return (
      <div className="grid gap-3" aria-busy>
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (preview.isError) return <FormBanner message={t("inviteInvalid")} />;

  const invite = preview.data;
  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-bold text-text-900">{t("inviteTitle", { business: invite.tenantName })}</h1>
        <p className="text-text-500">{t("inviteSubtitle", { role: invite.roleName, email: invite.email })}</p>
      </div>
      <form className="grid gap-4" noValidate onSubmit={form.handleSubmit((values) => accept.mutate(values))}>
        <FormBanner message={errors.root?.message} onDismiss={() => form.clearErrors("root")} />
        <Field id="name" label={t("yourName")} error={errors.name?.message}>
          <Input autoComplete="name" {...fieldProps("name", errors.name?.message)} {...form.register("name")} />
        </Field>
        <Field id="password" label={t("password")} hint={t("passwordHint")} error={errors.password?.message}>
          <Input
            type="password"
            autoComplete="new-password"
            {...fieldProps("password", errors.password?.message, true)}
            {...form.register("password")}
          />
        </Field>
        <Button
          type="submit"
          size="lg"
          className="w-full md:h-10 md:text-[15px]"
          loading={accept.isPending}
          loadingLabel={t("inviteProgress")}
        >
          {t("inviteAccept")}
        </Button>
      </form>
    </div>
  );
}
