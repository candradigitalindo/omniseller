import { Compass } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  const t = useTranslations("common");
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4">
      <div className="grid max-w-md justify-items-center gap-3 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-primary-50 text-primary-600">
          <Compass className="size-7" aria-hidden />
        </span>
        <h1 className="text-[22px] font-bold text-text-900">{t("notFoundTitle")}</h1>
        <p className="text-text-500">{t("notFoundBody")}</p>
        <Button asChild className="mt-2">
          <Link href="/">{t("backHome")}</Link>
        </Button>
      </div>
    </main>
  );
}
