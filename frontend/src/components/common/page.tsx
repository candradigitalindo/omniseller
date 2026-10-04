"use client";

import { cn } from "cn";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox,
  Info,
  type LucideIcon,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { formatRemaining } from "@/lib/format";

/** H1 on the left and the page's one primary action on the right, on the same line (6.2). */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3 md:mb-6">
      <div className="grid min-w-0 gap-1">
        <h1 className="text-[22px] leading-tight font-bold text-text-900 md:text-2xl">{title}</h1>
        {description ? <p className="text-text-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "promo";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-surface-2 text-text-700 ring-1 ring-inset ring-border",
  info: "bg-primary-100 text-primary-600",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  promo: "bg-promo-soft text-promo",
};

const TONE_ICON: Record<Tone, LucideIcon> = {
  neutral: Clock,
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertOctagon,
  promo: Sparkles,
};

/** A status is never only a color: icon, text, and color together (8.5). */
export function StatusPill({
  tone,
  icon,
  children,
  className,
}: {
  tone: Tone;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-full items-center gap-1 rounded-full px-2 text-[13px] font-medium whitespace-nowrap",
        TONE_CLASS[tone],
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Ship-by countdown (8.6): green beyond 6 hours, yellow from 1 to 6, red under an hour or late. */
export function SlaPill({ sla }: { sla: { state: "ok" | "warning" | "overdue"; remainingMs: number } }) {
  const tone: Tone =
    sla.state === "overdue" || sla.remainingMs < 3_600_000 ? "danger" : sla.state === "warning" ? "warning" : "success";
  return (
    <StatusPill tone={tone} icon={Clock}>
      {formatRemaining(sla.remainingMs)}
    </StatusPill>
  );
}

/** Empty state (8.6): one sentence about what comes next and at most one action. */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  body,
  action,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="grid justify-items-center gap-2 px-4 py-12 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-primary-50 text-primary-600">
        <Icon className="size-7" aria-hidden />
      </span>
      <p className="text-base font-semibold text-text-900">{title}</p>
      {body ? <p className="max-w-md text-text-500">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** A part of a page that failed to load: what happened, the short code, and "Coba lagi" (9). */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useTranslations("common");
  return (
    <div role="alert" className="grid justify-items-center gap-2 px-4 py-10 text-center">
      <AlertOctagon className="size-8 text-danger" aria-hidden />
      <p className="max-w-md text-text-700">{errorMessage(error)}</p>
      {error instanceof ApiError ? <p className="font-mono text-[13px] text-text-500">{error.code}</p> : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden />
          {t("retry")}
        </Button>
      ) : null}
    </div>
  );
}
