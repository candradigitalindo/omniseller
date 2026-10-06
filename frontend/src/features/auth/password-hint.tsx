"use client";

import { cn } from "cn";
import { useTranslations } from "next-intl";
import { passwordStrength } from "./shared";

/** Under a new password: the rule while it is empty, then a three-step strength meter (signup, account). */
export function PasswordHint({ password }: { password: string }) {
  const t = useTranslations("auth");
  if (!password) return <>{t("passwordHint")}</>;
  const strength = passwordStrength(password);
  const label = { weak: t("strengthWeak"), fair: t("strengthFair"), strong: t("strengthStrong") }[strength];
  return (
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
      {t("strength", { level: label })}
    </span>
  );
}
