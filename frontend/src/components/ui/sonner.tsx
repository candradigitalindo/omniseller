"use client";

import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  const t = useTranslations("common");

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      closeButton
      richColors
      visibleToasts={3}
      duration={6000}
      expand
      offset={24}
      mobileOffset={{ bottom: 88, left: 12, right: 12 }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        closeButtonAriaLabel: t("dismissAlert"),
        classNames: {
          toast: "cn-toast !rounded-2xl !p-4 !shadow-float !border-border",
          title: "!font-medium !leading-relaxed",
          description: "!text-text-500",
          closeButton: "!size-6 !rounded-full",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
