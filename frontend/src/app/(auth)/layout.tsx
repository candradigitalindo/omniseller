import { ArrowRight, Boxes, Check, Layers3, ShieldCheck, ShoppingBag, Sparkles, Truck, Users } from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Logo } from "@/components/common/logo";

/** Signing in and its siblings (L49): one 420 px card in the middle of the canvas, the logo above it. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations("auth");
  return (
    <main className="auth-canvas grid h-dvh min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden gap-5 px-4 py-5 sm:px-8 sm:py-6 lg:px-10">
      <header className="mx-auto flex w-full max-w-[1320px] items-center justify-between gap-4">
        <Logo />
        <span className="hidden items-center gap-2 rounded-full border bg-surface/80 px-3 py-1.5 text-xs text-text-500 sm:inline-flex">
          <ShieldCheck className="size-3.5 text-primary" aria-hidden />
          {t("secureSession")}
        </span>
      </header>
      <div className="auth-content-grid mx-auto grid h-full min-h-0 w-full max-w-[1320px] items-center gap-8 lg:grid-cols-[1.1fr_1fr] lg:gap-12">
        <aside className="relative hidden self-stretch overflow-hidden rounded-[32px] bg-[#123e50] p-10 text-white lg:flex lg:flex-col lg:justify-center xl:p-14">
          <div
            className="pointer-events-none absolute -top-28 -right-24 size-96 rounded-full border-[60px] border-white/5"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute -bottom-28 -left-28 size-80 rounded-full border-[50px] border-white/5"
            aria-hidden
          />
          <div className="relative grid gap-7">
            <span className="flex w-fit items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/85">
              <Sparkles className="size-3.5" aria-hidden />
              {t("welcomeBadge")}
            </span>
            <div className="grid gap-4">
              <h2 className="max-w-lg text-[34px] leading-[1.25] font-semibold tracking-tight whitespace-pre-line xl:text-[36px]">
                {t("heroTitle")}
              </h2>
              <p className="max-w-md text-[15px] leading-relaxed text-white/70">{t("heroDescription")}</p>
            </div>
            <section
              aria-label={t("previewLabel")}
              className="rounded-2xl border border-white/15 bg-white/10 p-4 shadow-xl backdrop-blur-sm xl:p-5"
            >
              <div className="mb-5 flex items-center justify-between gap-3 text-sm font-medium">
                <span className="flex items-center gap-2">
                  <Layers3 className="size-4 text-white/70" aria-hidden />
                  {t("previewTitle")}
                </span>
                <span className="grid size-6 place-items-center rounded-full bg-white/15">
                  <Check className="size-3.5" aria-hidden />
                </span>
              </div>
              <div className="flex items-center gap-2">
                {[
                  { key: "previewIncoming" as const, icon: ShoppingBag },
                  { key: "previewPacking" as const, icon: Boxes },
                  { key: "previewShipping" as const, icon: Truck },
                ].map(({ key, icon: Icon }, i) => (
                  <div key={key} className="contents">
                    <div className="grid flex-1 justify-items-center gap-2 rounded-xl border border-white/10 bg-white/10 px-2 py-4 transition-colors hover:bg-white/15">
                      <Icon className="size-5 text-white/85" aria-hidden />
                      <span className="text-center text-[11px] font-medium">{t(key)}</span>
                    </div>
                    {i < 2 ? <ArrowRight className="size-3 shrink-0 text-white/40" aria-hidden /> : null}
                  </div>
                ))}
              </div>
            </section>
            <div className="auth-benefits grid gap-4">
              {[
                { icon: ShoppingBag, title: "heroOrders" as const, body: "heroOrdersBody" as const },
                { icon: Boxes, title: "heroStock" as const, body: "heroStockBody" as const },
                { icon: Users, title: "heroTeam" as const, body: "heroTeamBody" as const },
              ].map(({ icon: Icon, title, body }) => (
                <div key={title} className="flex items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/10">
                    <Icon className="size-4 text-white/85" aria-hidden />
                  </span>
                  <div className="grid gap-0.5">
                    <p className="text-sm font-medium">{t(title)}</p>
                    <p className="text-xs leading-relaxed text-white/60">{t(body)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>
        <div className="flex max-h-full min-h-0 flex-col items-center justify-center gap-4 py-1 sm:py-3 lg:py-6">
          <div className="auth-form-panel w-full min-h-0 max-w-[460px] overflow-y-auto overscroll-contain rounded-[28px] border border-border/80 bg-surface p-6 shadow-[0_20px_70px_-25px_rgb(18_62_80/0.2)] sm:p-8 [&_h1]:text-[28px] [&_h1]:tracking-tight">
            {children}
          </div>
          <p className="flex shrink-0 items-center justify-center gap-2 text-center text-xs text-text-500">
            <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
            {t("secureSession")}
          </p>
        </div>
      </div>
      <footer className="mx-auto w-full max-w-[1320px] text-center text-[11px] text-text-500 lg:text-right">
        {t("authFooter")}
      </footer>
    </main>
  );
}
