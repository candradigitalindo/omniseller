"use client";

import { cn } from "cn";
import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ComponentProps, useState } from "react";
import { BaseInput } from "./input-base";
import { MoneyInput } from "./money-input";
import { TemporalInput } from "./temporal-input";

type InputProps = ComponentProps<"input"> & { currency?: boolean };
function PasswordInput({ className, ...props }: ComponentProps<"input">) {
  const t = useTranslations("common");
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative min-w-0">
      <BaseInput {...props} type={visible ? "text" : "password"} className={cn(className, "pr-12")} />
      <button
        type="button"
        disabled={props.disabled}
        aria-label={t(visible ? "hidePassword" : "showPassword")}
        aria-pressed={visible}
        className="absolute inset-y-1 right-1 grid w-10 place-items-center rounded-lg text-text-500 outline-none hover:bg-surface-2 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  );
}
function Input({ currency, type, ...props }: InputProps) {
  if (currency) return <MoneyInput {...props} />;
  if (type === "password") return <PasswordInput {...props} />;
  if (type === "date" || type === "time" || type === "datetime-local")
    return <TemporalInput {...props} type={type as "date" | "time" | "datetime-local"} />;
  return <BaseInput type={type} {...props} />;
}

export { Input };
