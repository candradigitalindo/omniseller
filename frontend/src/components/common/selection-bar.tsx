"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef } from "react";

/** The bar's height, for the room the app shell leaves under the page (its buttons wrap on phones). */
export const SELECTION_BAR_HEIGHT = "--selection-bar-height";

/**
 * Actions on the rows chosen in a list. On phones it floats above the bottom navigation (DOKUMEN-UI-UX 5:
 * card lists "with a sticky bottom action bar"), so it stays in reach while rows far down the list are
 * chosen; on wider screens it sticks under the top bar. While one is shown the app shell leaves room under
 * the page as tall as the bar, so the last rows can still be scrolled above it.
 */
export function SelectionBar({ count, children }: { count: string; children: ReactNode }) {
  const t = useTranslations("common");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => root.style.setProperty(SELECTION_BAR_HEIGHT, `${el.offsetHeight}px`));
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(SELECTION_BAR_HEIGHT);
    };
  }, []);
  return (
    <div
      ref={ref}
      data-slot="selection-bar"
      role="toolbar"
      aria-label={t("selectionActions")}
      className="z-20 flex flex-wrap items-center gap-2 rounded-[10px] border border-primary-100 bg-primary-50 px-3 py-2 shadow-card max-md:fixed max-md:inset-x-3 max-md:bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:sticky md:top-16 md:mb-3"
    >
      <span className="text-sm font-medium text-text-900" aria-live="polite">
        {count}
      </span>
      {children}
    </div>
  );
}
