"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, KeyRound, Settings2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { ChannelIcon, channelLabel } from "@/components/common/channel";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner, showServerErrors } from "@/components/common/form";
import { ErrorState, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { useSession } from "@/lib/session";

type Application = components["schemas"]["MarketplaceApplicationListDto_Output"]["items"][number];
type SettingsInput = components["schemas"]["MarketplaceApplicationInputDto"];
type Selection = { kind: "edit" | "remove" | "addresses"; application: Application };

/** Settings affect this business only. Secrets stay in the form until encrypted by the API. */
export function MarketplaceSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("marketplaceSettings");
  const cache = useQueryClient();
  const tenantId = useSession().tenant.id;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string>();
  const settings = useQuery({
    queryKey: ["marketplace-applications", tenantId],
    queryFn: () => unwrap(api.GET("/v1/marketplace-applications")),
    enabled: open,
  });
  const changed = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["marketplace-applications"] }),
      cache.invalidateQueries({ queryKey: ["channels"] }),
    ]);
    setSelection(null);
  };
  const close = () => {
    setSelection(null);
    setRemoveError(undefined);
    onClose();
  };
  const application = selection?.application;
  return (
    <Dialog open={open} onOpenChange={(value) => !value && close()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {selection?.kind === "remove"
              ? t("removeTitle")
              : application
                ? t("platformTitle", { name: channelLabel(application.channel) })
                : t("title")}
          </DialogTitle>
          <DialogDescription>
            {selection?.kind === "remove" ? t("removeHint") : application ? t("formHint") : t("description")}
          </DialogDescription>
        </DialogHeader>
        {application && selection?.kind === "edit" ? (
          <ApplicationForm
            key={application.channel}
            application={application}
            onBack={() => setSelection(null)}
            onSave={async (body) => {
              // Do not put credentials in a query/mutation cache or browser persistence.
              await unwrap(
                api.PUT("/v1/marketplace-applications/{channel}", {
                  params: { path: { channel: application.channel } },
                  body,
                }),
              );
              toast.success(t("saved"));
              await changed();
            }}
          />
        ) : application && selection?.kind === "addresses" ? (
          <div className="grid gap-4">
            <p className="text-sm text-text-500">{t("addressesHint")}</p>
            <Address label={t("redirectUrl")} value={application.redirectUrl} />
            {application.webhookUrl ? (
              <Address label={t("webhookUrl")} value={application.webhookUrl} />
            ) : (
              <p className="rounded-xl bg-warning-soft p-3 text-sm">{t("missingWebhook")}</p>
            )}
            <Button variant="outline" onClick={() => setSelection(null)}>
              <ArrowLeft aria-hidden />
              {t("back")}
            </Button>
          </div>
        ) : application && selection?.kind === "remove" ? (
          <div className="grid gap-4">
            <p className="rounded-xl bg-warning-soft p-3 text-sm">{t("replaceHint")}</p>
            <FormBanner message={removeError} />
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" disabled={removing} onClick={() => setSelection(null)}>
                {t("back")}
              </Button>
              <Button
                variant="destructive"
                loading={removing}
                loadingLabel={t("removing")}
                onClick={async () => {
                  setRemoving(true);
                  setRemoveError(undefined);
                  try {
                    await unwrap(
                      api.DELETE("/v1/marketplace-applications/{channel}", {
                        params: { path: { channel: application.channel } },
                        headers: { "If-Match": `"${application.rowVersion}"` },
                      }),
                    );
                    toast.success(t("removed"));
                    await changed();
                  } catch (error) {
                    setRemoveError(errorMessage(error));
                  } finally {
                    setRemoving(false);
                  }
                }}
              >
                <Trash2 aria-hidden />
                {t("removeConfirm")}
              </Button>
            </div>
          </div>
        ) : settings.isPending ? (
          <div role="status" aria-label={t("loading")}>
            <Skeleton className="h-40" />
            <p className="mt-2 text-sm text-text-500">{t("loading")}</p>
          </div>
        ) : settings.isError ? (
          <ErrorState error={settings.error} onRetry={() => settings.refetch()} />
        ) : (
          <div className="grid gap-3">
            {settings.data.items.map((item) => (
              <article key={item.channel} className="grid gap-3 rounded-xl border p-4">
                <div className="flex items-center gap-3">
                  <ChannelIcon channel={item.channel} className="size-9" decorative />
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold">{channelLabel(item.channel)}</h3>
                    <p className="text-sm text-text-500">{t(`source_${item.source}`)}</p>
                  </div>
                  <StatusPill tone={item.configured ? "success" : "warning"}>
                    {item.configured ? t("configured") : t("notConfigured")}
                  </StatusPill>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!item.settingsEnabled}
                    aria-label={t("configureName", { name: channelLabel(item.channel) })}
                    onClick={() => setSelection({ kind: "edit", application: item })}
                  >
                    <KeyRound aria-hidden />
                    {item.secretConfigured ? t("replace") : t("configure")}
                  </Button>
                  {item.secretConfigured ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelection({ kind: "addresses", application: item })}
                      >
                        {t("addresses")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("removeName", { name: channelLabel(item.channel) })}
                        onClick={() => {
                          setRemoveError(undefined);
                          setSelection({ kind: "remove", application: item });
                        }}
                      >
                        <Trash2 aria-hidden />
                        {t("remove")}
                      </Button>
                    </>
                  ) : null}
                </div>
                {!item.settingsEnabled ? <p className="text-sm text-warning">{t("encryptionRequired")}</p> : null}
              </article>
            ))}
            <p className="text-sm text-text-500">{t("afterSave")}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ApplicationForm({
  application,
  onBack,
  onSave,
}: {
  application: Application;
  onBack: () => void;
  onSave: (input: SettingsInput) => Promise<void>;
}) {
  const t = useTranslations("marketplaceSettings");
  const shopee = application.channel === "shopee";
  const schema = z
    .object({
      partnerId: z.string(),
      appKey: z.string(),
      serviceId: z.string(),
      secret: z.string().min(8, t("secretLength")).max(4096),
      environment: z.enum(["production", "sandbox"]),
    })
    .superRefine((value, ctx) => {
      if (shopee && !/^[1-9][0-9]{0,14}$/.test(value.partnerId))
        ctx.addIssue({ code: "custom", path: ["partnerId"], message: t("partnerIdInvalid") });
      if (!shopee)
        for (const field of ["appKey", "serviceId"] as const)
          if (!value[field].trim()) ctx.addIssue({ code: "custom", path: [field], message: t("required") });
    });
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      partnerId: application.partnerId ?? "",
      appKey: application.appKey ?? "",
      serviceId: application.serviceId ?? "",
      secret: "",
      environment: application.environment,
    },
  });
  const errors = form.formState.errors;
  return (
    <form
      className="grid gap-4"
      onSubmit={form.handleSubmit(async (value) => {
        try {
          await onSave({
            environment: shopee ? value.environment : "production",
            secret: value.secret,
            ...(application.rowVersion ? { expectedVersion: application.rowVersion } : {}),
            ...(shopee
              ? { partnerId: value.partnerId }
              : { appKey: value.appKey.trim(), serviceId: value.serviceId.trim() }),
          });
          form.reset({ ...value, secret: "" });
        } catch (error) {
          showServerErrors(form, error);
        }
      })}
    >
      <FormBanner message={errors.root?.message} />
      {shopee ? (
        <Field id="marketplace-partner-id" label={t("partnerId")} error={errors.partnerId?.message}>
          <Input
            {...fieldProps("marketplace-partner-id", errors.partnerId?.message)}
            {...form.register("partnerId")}
            inputMode="numeric"
            maxLength={15}
            autoComplete="off"
          />
        </Field>
      ) : (
        <>
          <Field id="marketplace-app-key" label={t("appKey")} error={errors.appKey?.message}>
            <Input
              {...fieldProps("marketplace-app-key", errors.appKey?.message)}
              {...form.register("appKey")}
              maxLength={200}
              autoComplete="off"
            />
          </Field>
          <Field
            id="marketplace-service-id"
            label={t("serviceId")}
            hint={t("serviceIdHint")}
            error={errors.serviceId?.message}
          >
            <Input
              {...fieldProps("marketplace-service-id", errors.serviceId?.message, true)}
              {...form.register("serviceId")}
              maxLength={200}
              autoComplete="off"
            />
          </Field>
        </>
      )}
      <Field
        id="marketplace-secret"
        label={shopee ? t("partnerKey") : t("appSecret")}
        hint={t("secretHint")}
        error={errors.secret?.message}
      >
        <Input
          {...fieldProps("marketplace-secret", errors.secret?.message, true)}
          {...form.register("secret")}
          type="password"
          autoComplete="new-password"
          maxLength={4096}
        />
      </Field>
      {shopee ? (
        <Field id="marketplace-environment" label={t("environment")}>
          <Select
            value={form.watch("environment")}
            onValueChange={(value) => form.setValue("environment", value as "production" | "sandbox")}
          >
            <SelectTrigger id="marketplace-environment">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="production">{t("production")}</SelectItem>
              <SelectItem value="sandbox">{t("sandbox")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      ) : (
        <p className="text-sm text-text-500">{t("tiktokTestHint")}</p>
      )}
      {application.secretConfigured || application.source === "platform" ? (
        <p className="rounded-xl bg-warning-soft p-3 text-sm">{t("replaceHint")}</p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" disabled={form.formState.isSubmitting} onClick={onBack}>
          {t("back")}
        </Button>
        <Button loading={form.formState.isSubmitting} loadingLabel={t("saving")}>
          <Settings2 aria-hidden />
          {t("save")}
        </Button>
      </div>
    </form>
  );
}

function Address({ label, value }: { label: string; value: string }) {
  const t = useTranslations("marketplaceSettings");
  const id = useId();
  return (
    <div className="grid gap-2">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <div className="flex gap-2">
        <Input id={id} value={value} readOnly className="min-w-0 font-mono text-xs" />
        <Button
          variant="outline"
          size="icon"
          aria-label={t("copyAddress", { name: label })}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              toast.success(t("copied"));
            } catch {
              toast.error(t("copyFailed"));
            }
          }}
        >
          <Copy aria-hidden />
        </Button>
      </div>
    </div>
  );
}
