"use client";

import { cn } from "cn";
import { Check, ChevronDown, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { Popover as PopoverPrimitive, type Select as SelectPrimitive } from "radix-ui";
import {
  Children,
  type ComponentProps,
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
  useId,
  useRef,
  useState,
} from "react";
import { BaseInput } from "./input-base";

type Option = { value: string; label: ReactNode; text: string; disabled: boolean };
function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? textOf(child.props.children)
        : typeof child === "string" || typeof child === "number"
          ? String(child)
          : "",
    )
    .join(" ")
    .trim();
}
function optionsOf(node: ReactNode): Option[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<{ value?: string; children?: ReactNode; textValue?: string; disabled?: boolean }>(child))
      return [];
    if (child.type === SelectItem && child.props.value !== undefined)
      return [
        {
          value: child.props.value,
          label: child.props.children,
          text: child.props.textValue ?? textOf(child.props.children),
          disabled: !!child.props.disabled,
        },
      ];
    return optionsOf(child.props.children);
  });
}
const SelectContext = createContext<{
  value: string;
  choose: (v: string) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  disabled: boolean;
  id: string;
  options: Option[];
} | null>(null);
const SearchContext = createContext("");
function useSelect() {
  const context = useContext(SelectContext);
  if (!context) throw new Error("Select components require Select.");
  return context;
}

/** A searchable listbox with the same public API as the original Select. */
function Select({
  children,
  value: controlled,
  defaultValue = "",
  onValueChange,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  name,
  required,
  dir,
}: ComponentProps<typeof SelectPrimitive.Root>) {
  const [localValue, setLocalValue] = useState(defaultValue);
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const value = controlled ?? localValue;
  const open = controlledOpen ?? localOpen;
  const id = useId();
  const options = optionsOf(children);
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  const choose = (next: string) => {
    if (!next) return;
    setLocalValue(next);
    onValueChange?.(next);
    setOpen(false);
  };
  return (
    <SelectContext value={{ value, choose, open, setOpen, disabled, id, options }}>
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        {children}
      </PopoverPrimitive.Root>
      {name ? (
        <select
          hidden
          aria-hidden
          tabIndex={-1}
          name={name}
          required={required}
          disabled={disabled}
          value={value}
          onChange={(e) => choose(e.target.value)}
          dir={dir}
        >
          <option value="" />
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.text}
            </option>
          ))}
        </select>
      ) : null}
    </SelectContext>
  );
}
function SelectTrigger({
  className,
  children,
  size = "default",
  onKeyDown,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger> & { size?: "sm" | "default" }) {
  const s = useSelect();
  return (
    <PopoverPrimitive.Trigger asChild>
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={s.open}
        aria-controls={s.open ? s.id : undefined}
        disabled={s.disabled}
        data-slot="select-trigger"
        data-size={size}
        className={cn(
          "flex min-h-10 max-w-full items-center justify-between gap-2 rounded-xl border border-input bg-surface px-3 py-2 text-sm text-text-900 shadow-xs transition-colors outline-none hover:border-border-strong focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/10 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-[size=sm]:min-h-8 [&_svg]:size-4 [&_svg]:shrink-0",
          className,
        )}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (!e.defaultPrevented && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            s.setOpen(true);
          }
        }}
        {...props}
      >
        {children}
        <ChevronDown aria-hidden className={cn("text-text-500 transition-transform", s.open && "rotate-180")} />
      </button>
    </PopoverPrimitive.Trigger>
  );
}
function SelectValue({ placeholder, children, ...props }: ComponentProps<typeof SelectPrimitive.Value>) {
  const s = useSelect();
  return (
    <span data-slot="select-value" className="flex min-w-0 items-center gap-1.5 truncate text-left" {...props}>
      {children ?? s.options.find((o) => o.value === s.value)?.label ?? placeholder ?? s.value}
    </span>
  );
}
function SelectContent({
  children,
  className,
  position: _position,
  align = "start",
  onCloseAutoFocus,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  const t = useTranslations("common");
  const s = useSelect();
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const normalized = query.trim().toLocaleLowerCase("id-ID");
  const count = s.options.filter((o) => o.text.toLocaleLowerCase("id-ID").includes(normalized)).length;
  const navigate = (e: React.KeyboardEvent<HTMLElement>) => {
    const options = Array.from(
      list.current?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? [],
    );
    const index = options.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown") next = options[(index + 1) % options.length];
    else if (e.key === "ArrowUp") next = options[(index <= 0 ? options.length : index) - 1];
    else if (e.target !== search.current && e.key === "Home") next = options[0];
    else if (e.target !== search.current && e.key === "End") next = options.at(-1);
    if (next) {
      e.preventDefault();
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    } else if (e.target !== search.current && e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey) {
      setQuery((q) => q + e.key);
      search.current?.focus();
      e.preventDefault();
    }
  };
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        role="presentation"
        align={align}
        sideOffset={6}
        data-slot="select-content"
        className={cn(
          "z-50 w-(--radix-popover-trigger-width) min-w-56 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border bg-popover p-1.5 text-popover-foreground shadow-float outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className,
        )}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          setQuery("");
          search.current?.focus();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        {...props}
      >
        <div role="presentation">
          <div className="relative mb-1.5 border-b pb-1.5">
            <Search aria-hidden className="pointer-events-none absolute top-3 left-3 size-4 text-text-500" />
            <BaseInput
              ref={search}
              type="search"
              role="searchbox"
              aria-label={t("searchOptions")}
              placeholder={t("searchOptions")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={navigate}
              className="h-10 border-0 bg-surface-2 pl-9 shadow-none md:h-10"
            />
          </div>
          <div
            ref={list}
            onKeyDown={navigate}
            id={s.id}
            role="listbox"
            aria-label={t("searchOptions")}
            className="max-h-[min(16rem,40dvh)] overflow-y-auto overscroll-contain p-0.5"
          >
            <SearchContext value={normalized}>{children}</SearchContext>
            {!count ? (
              <p role="status" className="px-3 py-6 text-center text-sm text-text-500">
                {t("noOptions")}
              </p>
            ) : null}
          </div>
        </div>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}
function SelectItem({
  value,
  children,
  disabled,
  textValue,
  className,
  onClick,
  onKeyDown,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  const s = useSelect();
  const query = useContext(SearchContext);
  if (!(textValue ?? textOf(children)).toLocaleLowerCase("id-ID").includes(query)) return null;
  const choose = () => !disabled && s.choose(value);
  return (
    <div
      role="option"
      tabIndex={disabled ? undefined : -1}
      aria-selected={s.value === value}
      aria-disabled={disabled || undefined}
      data-slot="select-item"
      data-value={value}
      className={cn(
        "relative flex min-h-10 cursor-pointer items-center gap-2 rounded-lg py-2 pr-9 pl-3 text-sm outline-none select-none hover:bg-accent focus:bg-accent aria-selected:bg-primary-50 aria-selected:font-medium aria-selected:text-primary aria-disabled:pointer-events-none aria-disabled:opacity-40 [&_svg]:size-4",
        className,
      )}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) choose();
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (!e.defaultPrevented && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          choose();
        }
      }}
      {...props}
    >
      {children}
      {s.value === value ? <Check className="absolute right-2.5 size-4" aria-hidden /> : null}
    </div>
  );
}
function SelectGroup({ className, ...props }: ComponentProps<typeof SelectPrimitive.Group>) {
  return <fieldset className={cn("p-0.5", className)} {...(props as ComponentProps<"fieldset">)} />;
}
function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return <div className={cn("px-3 py-2 text-xs font-semibold text-text-500", className)} {...props} />;
}
function SelectSeparator({ className, ...props }: ComponentProps<typeof SelectPrimitive.Separator>) {
  return <hr className={cn("my-1 h-px bg-border", className)} {...(props as ComponentProps<"hr">)} />;
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue };
