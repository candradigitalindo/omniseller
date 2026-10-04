"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { AlertTriangle, ArrowRight, Plug, RefreshCw, Store as StoreIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { ChannelIcon, channelLabel } from "@/components/common/channel";
import { Field, fieldProps } from "@/components/common/field";
import { FormBanner, showServerErrors } from "@/components/common/form";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatRelative } from "@/lib/format";
import { leaveTo } from "@/lib/navigate";
import { useCan, useTimeZone } from "@/lib/session";
import { type MarketplaceChannel, needsReconnect, STORE_TONE, type Store, sortStores } from "./store-meta";

/** Sends the browser to the marketplace's consent page; it comes back to /integrasi/callback/{channel}. */
function useStartAuthorization() {
  return useMutation({
    mutationFn: (body: { channel: MarketplaceChannel; storeId?: string }) =>
      unwrap(api.POST("/v1/store-authorizations", { body })),
    onSuccess: (started) => leaveTo(started.authorizeUrl),
    onError: (error) => toast.error(errorMessage(error)),
  });
}

/**
 * L40 Toko Terhubung (DOKUMEN-UI-UX 14.7): a card per store with its connection, sync mode, and what
 * needs the seller; "Hubungkan toko" opens the wizard.
 */
export function StoresView() {
  const t = useTranslations("stores");
  const can = useCan();
  const [connecting, setConnecting] = useState(false);
  const stores = useQuery({ queryKey: ["stores"], queryFn: () => unwrap(api.GET("/v1/stores")) });
  const manage = can("settings:store");
  const list = sortStores(stores.data?.items ?? []);

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          manage ? (
            <Button onClick={() => setConnecting(true)}>
              <Plug aria-hidden />
              {t("connect")}
            </Button>
          ) : null
        }
      />
      {stores.isPending ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-[10px]" />
          ))}
        </div>
      ) : stores.isError ? (
        <ErrorState error={stores.error} onRetry={() => stores.refetch()} />
      ) : list.length === 0 ? (
        <div className="rounded-[10px] border bg-surface">
          <EmptyState
            icon={Plug}
            title={t("emptyTitle")}
            body={t("emptyBody")}
            action={manage ? <Button onClick={() => setConnecting(true)}>{t("connect")}</Button> : undefined}
          />
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((s) => (
            <li key={s.id}>
              <StoreCard store={s} manage={manage} />
            </li>
          ))}
        </ul>
      )}
      <ConnectDialog open={connecting} onClose={() => setConnecting(false)} />
    </>
  );
}

function StoreCard({ store: s, manage }: { store: Store; manage: boolean }) {
  const t = useTranslations("stores");
  const tz = useTimeZone();
  const start = useStartAuthorization();
  const manual = s.channel === "manual";
  const disconnected = s.status === "disconnected";
  return (
    <article
      className={cn(
        "grid h-full content-start gap-3 rounded-[10px] border bg-surface p-4 shadow-card",
        disconnected && "opacity-70",
      )}
    >
      <header className="flex items-start gap-3">
        <ChannelIcon channel={s.channel} className="size-9 text-sm" decorative />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h2 className="truncate text-base font-semibold text-text-900">{s.name}</h2>
          <span className="text-[13px] text-text-500">{channelLabel(s.channel)}</span>
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {manual ? (
          <StatusPill tone="neutral" icon={StoreIcon}>
            {t("manualPill")}
          </StatusPill>
        ) : (
          <StatusPill tone={STORE_TONE[s.status]}>{t(`status_${s.status}`)}</StatusPill>
        )}
        {!manual && !disconnected && s.syncMode === "read_only" ? (
          <StatusPill tone="warning">{t("readOnly")}</StatusPill>
        ) : null}
      </div>

      <div className="grid gap-1 text-sm text-text-700">
        {manual ? (
          <p>{t("manualBody")}</p>
        ) : disconnected ? (
          <p>{s.statusMessage ?? t("disconnectedBody")}</p>
        ) : (
          <>
            {s.statusMessage && s.status !== "active" ? <p className="text-text-900">{s.statusMessage}</p> : null}
            <p>
              {s.lastOrderSyncAt
                ? t("ordersSynced", { when: formatRelative(s.lastOrderSyncAt, tz) })
                : t("firstImport")}
            </p>
            {s.unmappedWarehouses > 0 ? (
              <p className="flex items-start gap-1.5 text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {t("unmappedWarehouses", { count: s.unmappedWarehouses })}
              </p>
            ) : null}
          </>
        )}
      </div>

      {manage && !manual && needsReconnect(s.status) && (s.channel === "shopee" || s.channel === "tiktokshop") ? (
        <Button
          className="justify-self-start"
          variant={s.status === "reauth_required" ? "default" : "secondary"}
          loading={start.isPending}
          onClick={() => start.mutate({ channel: s.channel as MarketplaceChannel, storeId: s.id })}
        >
          <RefreshCw aria-hidden />
          {t("reconnect")}
        </Button>
      ) : null}
    </article>
  );
}

type Step =
  | { kind: "choose" }
  | { kind: "marketplace"; channel: MarketplaceChannel; name: string }
  | { kind: "manual" };

/** The connect wizard of L40: choose a marketplace (or a manual sales channel), read what happens, go. */
function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const close = () => {
    onClose();
    setStep({ kind: "choose" });
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-[560px]">
        {step.kind === "choose" ? (
          <ChooseChannel onPick={setStep} />
        ) : step.kind === "marketplace" ? (
          <ConfirmMarketplace channel={step.channel} name={step.name} onBack={() => setStep({ kind: "choose" })} />
        ) : (
          <ManualChannelForm onBack={() => setStep({ kind: "choose" })} onDone={close} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChooseChannel({ onPick }: { onPick: (step: Step) => void }) {
  const t = useTranslations("stores");
  const channels = useQuery({
    queryKey: ["channels"],
    queryFn: () => unwrap(api.GET("/v1/channels")),
    staleTime: 300_000,
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("chooseTitle")}</DialogTitle>
        <DialogDescription>{t("chooseBody")}</DialogDescription>
      </DialogHeader>
      {channels.isPending ? (
        <Skeleton className="h-28" />
      ) : channels.isError ? (
        <ErrorState error={channels.error} onRetry={() => channels.refetch()} />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {channels.data.items.map((c) => (
            <li key={c.id}>
              <ChannelChoice
                channel={c.id}
                title={channelLabel(c.id)}
                hint={c.available ? t("marketplaceHint") : t("unavailable")}
                disabled={!c.available}
                onClick={() => onPick({ kind: "marketplace", channel: c.id, name: channelLabel(c.id) })}
              />
            </li>
          ))}
          <li>
            <ChannelChoice
              channel="manual"
              title={t("manualTitle")}
              hint={t("manualHint")}
              onClick={() => onPick({ kind: "manual" })}
            />
          </li>
        </ul>
      )}
    </>
  );
}

function ChannelChoice({
  channel,
  title,
  hint,
  disabled,
  onClick,
}: {
  channel: string;
  title: string;
  hint: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-full w-full items-start gap-3 rounded-[10px] border p-4 text-left outline-none hover:border-primary hover:bg-primary-50 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
    >
      <ChannelIcon channel={channel} className="size-9 text-sm" decorative />
      <span className="grid gap-0.5">
        <span className="font-semibold text-text-900">{title}</span>
        <span className="text-[13px] text-text-500">{hint}</span>
      </span>
    </button>
  );
}

function ConfirmMarketplace({
  channel,
  name,
  onBack,
}: {
  channel: MarketplaceChannel;
  name: string;
  onBack: () => void;
}) {
  const t = useTranslations("stores");
  const start = useStartAuthorization();
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("confirmTitle", { channel: name })}</DialogTitle>
        <DialogDescription>{t("confirmBody", { channel: name })}</DialogDescription>
      </DialogHeader>
      <ol className="grid list-decimal gap-1.5 pl-5 text-sm text-text-700">
        <li>{t("confirmStep1", { channel: name })}</li>
        <li>{t("confirmStep2")}</li>
        <li>{t("confirmStep3")}</li>
      </ol>
      <DialogFooter>
        <Button variant="secondary" onClick={onBack}>
          {t("back")}
        </Button>
        <Button loading={start.isPending || start.isSuccess} onClick={() => start.mutate({ channel })}>
          {t("continueTo", { channel: name })}
          <ArrowRight aria-hidden />
        </Button>
      </DialogFooter>
    </>
  );
}

function ManualChannelForm({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const t = useTranslations("stores");
  const queryClient = useQueryClient();
  const schema = z.object({ name: z.string().trim().min(1, t("nameRequired")).max(100, t("nameTooLong")) });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: "" } });
  const create = useMutation({
    mutationFn: (v: Values) => unwrap(api.POST("/v1/stores/manual", { body: { name: v.name } })),
    onSuccess: (store) => {
      toast.success(t("manualCreated", { name: store.name }));
      void queryClient.invalidateQueries({ queryKey: ["stores"] });
      onDone();
    },
    onError: (error) => showServerErrors(form, error),
  });
  const { errors } = form.formState;
  return (
    <form className="grid gap-4" noValidate onSubmit={form.handleSubmit((v) => create.mutate(v))}>
      <DialogHeader>
        <DialogTitle>{t("manualTitle")}</DialogTitle>
        <DialogDescription>{t("manualFormBody")}</DialogDescription>
      </DialogHeader>
      <FormBanner message={errors.root?.message} />
      <Field id="manual-name" label={t("manualName")} hint={t("manualNameHint")} error={errors.name?.message}>
        <Input autoFocus {...fieldProps("manual-name", errors.name?.message, true)} {...form.register("name")} />
      </Field>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onBack}>
          {t("back")}
        </Button>
        <Button type="submit" loading={create.isPending}>
          {t("manualCreate")}
        </Button>
      </DialogFooter>
    </form>
  );
}
