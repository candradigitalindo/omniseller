"use client";

import { cn } from "cn";
import { useTranslations } from "next-intl";
import { type ChangeEvent, type ComponentProps, useId, useLayoutEffect, useRef } from "react";
import { moneyText, parseMoneyText } from "@/lib/localized-input";
import { BaseInput } from "./input-base";

/** Displays grouped rupiah while controlled form state and requests retain unformatted integers. */
export function MoneyInput({ value = "", onChange, className, onPaste, ref, ...props }: ComponentProps<"input">) {
  const t = useTranslations("common");
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const raw = String(value);
  const display = moneyText(raw);
  const invalid = raw !== "" && !/^\d+$/.test(raw);
  const showError = invalid && !props["aria-invalid"];
  useLayoutEffect(() => {
    if (caret.current === null || !input.current || document.activeElement !== input.current) return;
    const digitsToRight = caret.current;
    let position = display.length;
    for (let n = 0; position > 0 && n < digitsToRight; position--) if (/\d/.test(display[position - 1] ?? "")) n++;
    input.current.setSelectionRange(position, position);
    caret.current = null;
  }, [display]);
  const send = (event: ChangeEvent<HTMLInputElement>, next: string) =>
    onChange?.({
      ...event,
      target: { ...event.target, name: props.name ?? "", value: next },
      currentTarget: { ...event.currentTarget, value: next },
    });
  return (
    <div className="min-w-0">
      <div className="relative">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-sm font-medium text-text-500"
        >
          Rp
        </span>
        <BaseInput
          {...props}
          ref={(node) => {
            input.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          type="text"
          inputMode="numeric"
          value={display}
          aria-invalid={invalid || props["aria-invalid"] || undefined}
          aria-describedby={[props["aria-describedby"], `${id}-hint`, showError ? `${id}-error` : null]
            .filter(Boolean)
            .join(" ")}
          className={cn(className, "tabular pl-11")}
          onChange={(e) => {
            const native = e.nativeEvent as InputEvent;
            const editingDigits =
              (raw === "" || /^\d+$/.test(raw)) &&
              /^(?:insertText|delete)/.test(native.inputType ?? "") &&
              (native.data == null || /^\d+$/.test(native.data));
            const text = e.target.value;
            const next = editingDigits ? text.replaceAll(".", "") : (parseMoneyText(text) ?? text);
            caret.current = text.slice(e.target.selectionStart ?? text.length).replace(/\D/g, "").length;
            e.target.setCustomValidity(next && !/^\d+$/.test(next) ? t("invalidMoney") : "");
            send(e, next);
          }}
          onPaste={(e) => {
            onPaste?.(e);
            if (e.defaultPrevented) return;
            const pasted = parseMoneyText(e.clipboardData.getData("text"));
            if (pasted === null) {
              e.preventDefault();
              input.current?.setCustomValidity(t("invalidMoney"));
              const node = input.current;
              if (node)
                send(
                  { target: node, currentTarget: node } as ChangeEvent<HTMLInputElement>,
                  e.clipboardData
                    .getData("text")
                    .replace(/^\s*Rp\s*/i, "")
                    .trim(),
                );
              return;
            }
            // Preserve the normal input event and caret for digit-only pastes; handle an explicit Rp prefix.
            if (/Rp/i.test(e.clipboardData.getData("text"))) {
              e.preventDefault();
              const node = input.current;
              if (node) {
                node.setCustomValidity("");
                send({ target: node, currentTarget: node } as ChangeEvent<HTMLInputElement>, pasted);
              }
            }
          }}
        />
      </div>
      <span id={`${id}-hint`} className="sr-only">
        {t("rupiahHint")}
      </span>
      {showError ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger">
          {t("invalidMoney")}
        </p>
      ) : null}
    </div>
  );
}
