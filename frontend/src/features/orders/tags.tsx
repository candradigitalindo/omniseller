"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { Plus, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { FormBanner } from "@/components/common/form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import {
  MAX_TAGS,
  matchingTags,
  nextTagColor,
  nextTagState,
  TAG_COLORS,
  type Tag,
  type TagRef,
  type TagState,
  tagChanges,
  tagNameProblem,
  tagStates,
} from "./tag-meta";

export const tagsQueryKey = ["tags"] as const;
type TagList = { items: Tag[] };

/** The business's tags (`GET /v1/tags`), shared by the filter, "Beri tag", and "Kelola tag". */
export function useTags(enabled = true) {
  return useQuery({
    queryKey: tagsQueryKey,
    queryFn: () => unwrap(api.GET("/v1/tags")),
    staleTime: 60_000,
    enabled,
  });
}

export function TagDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", !color && "bg-text-500")}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

/** A tag as a pill: its color as a dot, its name in text ink, never in the tag's color (DOKUMEN-UI-UX 13). */
export function TagPill({ tag, className }: { tag: TagRef; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border bg-surface px-2 text-[13px] text-text-700",
        className,
      )}
    >
      <TagDot color={tag.color} />
      <span className="truncate">{tag.name}</span>
    </span>
  );
}

/** Up to `max` pills and "+n" for the rest, as in the rows of the order list. */
export function TagPills({ tags, max = 3 }: { tags: readonly TagRef[]; max?: number }) {
  const t = useTranslations("orderTags");
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {tags.slice(0, max).map((tag) => (
        <TagPill key={tag.id} tag={tag} />
      ))}
      {tags.length > max ? (
        <span className="text-[13px] text-text-500">{t("more", { count: tags.length - max })}</span>
      ) : null}
    </span>
  );
}

/**
 * "Beri tag" (L03 bulk bar, L04): every tag with a box saying whether all, some, or none of the orders carry
 * it. Typing filters the list and offers to make a new tag. "Terapkan" sends only what changed.
 */
export function TagPicker({
  orders,
  trigger,
  onManage,
  onApplied,
  align = "start",
}: {
  orders: readonly { id: string; tags: readonly TagRef[] }[];
  trigger: ReactNode;
  onManage?: (() => void) | undefined;
  /** After the tags were saved, as the other bulk actions end the selection. */
  onApplied?: (() => void) | undefined;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align={align} className="w-80 gap-0 p-0">
        {open ? (
          <PickerBody
            orders={orders}
            onDone={() => {
              setOpen(false);
              onApplied?.();
            }}
            onManage={
              onManage
                ? () => {
                    setOpen(false);
                    onManage();
                  }
                : undefined
            }
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function PickerBody({
  orders,
  onDone,
  onManage,
}: {
  orders: readonly { id: string; tags: readonly TagRef[] }[];
  onDone: () => void;
  onManage: (() => void) | undefined;
}) {
  const t = useTranslations("orderTags");
  const queryClient = useQueryClient();
  const tags = useTags();
  const [query, setQuery] = useState("");
  const [changed, setChanged] = useState<Record<string, TagState>>({});
  const all = tags.data?.items ?? [];
  const before = tagStates(
    orders,
    all.map((x) => x.id),
  );
  const after = { ...before, ...changed };
  const changes = tagChanges(before, after);
  const shown = matchingTags(all, query);
  const typed = query.trim();
  const canCreate = typed !== "" && tagNameProblem(typed, all) === null && all.length < MAX_TAGS;

  const create = useMutation({
    mutationFn: (name: string) => unwrap(api.POST("/v1/tags", { body: { name, color: nextTagColor(all.length) } })),
    onSuccess: (tag) => {
      // shown at once, ticked for every order; the list is read again behind it
      queryClient.setQueryData<TagList>(tagsQueryKey, (old) =>
        old ? { items: [...old.items, tag].sort((a, b) => a.name.localeCompare(b.name, "id")) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: tagsQueryKey });
      setChanged((c) => ({ ...c, [tag.id]: "all" }));
      setQuery("");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const apply = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/orders/tags", { body: { orderIds: orders.map((o) => o.id), ...changes } })),
    onSuccess: (r) => {
      toast.success(t("applied", { count: r.items.length }));
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: tagsQueryKey });
      onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="grid">
      <div className="grid gap-2 border-b p-3">
        <p className="text-sm font-semibold text-text-900">
          {orders.length === 1 ? t("pickerOne") : t("pickerMany", { count: orders.length })}
        </p>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-500"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCreate && shown.length === 0) {
                e.preventDefault();
                create.mutate(typed);
              }
            }}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            maxLength={30}
            className="h-9 pl-8"
          />
        </div>
      </div>
      <ul className="grid max-h-64 gap-0.5 overflow-y-auto p-1.5" aria-label={t("list")}>
        {shown.map((tag) => {
          const state = after[tag.id] ?? "none";
          const id = `pick-${tag.id}`;
          return (
            <li key={tag.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-2">
              <Checkbox
                id={id}
                checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
                onCheckedChange={() =>
                  setChanged((c) => ({ ...c, [tag.id]: nextTagState(state, before[tag.id] ?? "none") }))
                }
              />
              <Label htmlFor={id} className="flex min-w-0 flex-1 items-center gap-2 font-normal text-text-900">
                <TagDot color={tag.color} />
                <span className="truncate">{tag.name}</span>
              </Label>
            </li>
          );
        })}
        {canCreate ? (
          <li>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-primary-600 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
              disabled={create.isPending}
              onClick={() => create.mutate(typed)}
            >
              <Plus className="size-4" aria-hidden />
              {t("createNamed", { name: typed })}
            </button>
          </li>
        ) : null}
        {all.length === 0 && !canCreate ? (
          <li className="px-2 py-1.5 text-sm text-text-500">{tags.isPending ? t("loading") : t("emptyPicker")}</li>
        ) : null}
        {all.length >= MAX_TAGS && typed !== "" && shown.length === 0 ? (
          <li className="px-2 py-1.5 text-sm text-text-500">{t("limit", { max: MAX_TAGS })}</li>
        ) : null}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t p-2">
        {onManage ? (
          <Button size="sm" variant="ghost" onClick={onManage}>
            {t("manage")}
          </Button>
        ) : (
          <span />
        )}
        <Button
          size="sm"
          disabled={changes.add.length + changes.remove.length === 0}
          loading={apply.isPending}
          onClick={() => apply.mutate()}
        >
          {t("apply")}
        </Button>
      </div>
    </div>
  );
}

/**
 * "Kelola tag" (FR-ORD-04): the business's tags with how many orders carry each, a new tag, a new name or
 * color, and deleting a tag, which takes it off every order.
 */
export function TagsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("orderTags");
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("manageTitle")}</DialogTitle>
          <DialogDescription>{t("manageBody")}</DialogDescription>
        </DialogHeader>
        {open ? <TagManager /> : null}
      </DialogContent>
    </Dialog>
  );
}

function TagManager() {
  const t = useTranslations("orderTags");
  const tags = useTags();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const all = tags.data?.items ?? [];
  const full = all.length >= MAX_TAGS;

  const remove = useMutation({
    mutationFn: (tag: Tag) => unwrap(api.DELETE("/v1/tags/{id}", { params: { path: { id: tag.id } } })),
    onSuccess: (_, tag) => {
      toast.success(t("deleted", { name: tag.name }));
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: tagsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="grid gap-3">
      {editing === "new" ? (
        <TagForm tags={all} onDone={() => setEditing(null)} />
      ) : (
        <Button variant="secondary" className="justify-self-start" disabled={full} onClick={() => setEditing("new")}>
          <Plus aria-hidden />
          {t("add")}
        </Button>
      )}
      {full ? <p className="text-sm text-text-500">{t("limit", { max: MAX_TAGS })}</p> : null}
      {tags.isPending ? null : all.length === 0 ? (
        <p className="text-sm text-text-500">{t("emptyManager")}</p>
      ) : (
        <ul className="grid max-h-80 divide-y overflow-y-auto rounded-lg border" aria-label={t("list")}>
          {all.map((tag) =>
            editing === tag.id ? (
              <li key={tag.id} className="p-3">
                <TagForm tag={tag} tags={all} onDone={() => setEditing(null)} />
              </li>
            ) : deleting === tag.id ? (
              <li key={tag.id} className="grid gap-2 bg-danger-soft p-3">
                <p className="text-sm text-text-900">
                  {tag.orders > 0
                    ? t("deleteAsk", { name: tag.name, count: tag.orders })
                    : t("deleteAskUnused", { name: tag.name })}
                </p>
                <span className="flex gap-2">
                  <Button size="sm" variant="destructive" loading={remove.isPending} onClick={() => remove.mutate(tag)}>
                    {t("deleteConfirm")}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setDeleting(null)}>
                    {t("keep")}
                  </Button>
                </span>
              </li>
            ) : (
              <li key={tag.id} className="flex items-center gap-2 px-3 py-2">
                <TagPill tag={tag} />
                <span className="flex-1 text-[13px] text-text-500">{t("orders", { count: tag.orders })}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("editNamed", { name: tag.name })}
                  onClick={() => {
                    setDeleting(null);
                    setEditing(tag.id);
                  }}
                >
                  {t("edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("deleteNamed", { name: tag.name })}
                  onClick={() => {
                    setEditing(null);
                    setDeleting(tag.id);
                  }}
                >
                  {t("delete")}
                </Button>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

/** A new tag, or a tag's new name and color: only what changed is sent. */
function TagForm({ tag, tags, onDone }: { tag?: Tag; tags: readonly Tag[]; onDone: () => void }) {
  const t = useTranslations("orderTags");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const formId = useId();
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState<string | null>(tag ? tag.color : nextTagColor(tags.length));
  const [error, setError] = useState<string | undefined>();
  const [banner, setBanner] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: (body: { name?: string; color?: string | null }) =>
      tag
        ? unwrap(api.PATCH("/v1/tags/{id}", { params: { path: { id: tag.id } }, body }))
        : unwrap(api.POST("/v1/tags", { body: { name: body.name ?? "", color: body.color ?? null } })),
    onSuccess: (saved) => {
      toast.success(tag ? t("saved", { name: saved.name }) : t("created", { name: saved.name }));
      void queryClient.invalidateQueries({ queryKey: tagsQueryKey });
      // a new name or color shows on the orders that carry the tag
      if (tag) void queryClient.invalidateQueries({ queryKey: ["orders"] });
      onDone();
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === "tag.duplicate" || e.fieldMessage("name"))) {
        setError(e.code === "tag.duplicate" ? t("name_taken") : e.fieldMessage("name"));
      } else setBanner(errorMessage(e));
    },
  });

  const submit = () => {
    setBanner(undefined);
    const problem = tagNameProblem(name, tags, tag?.id ?? null);
    if (problem) return setError(t(`name_${problem}`));
    const typed = name.trim();
    const body = tag
      ? {
          ...(typed !== tag.name ? { name: typed } : {}),
          ...(color !== tag.color ? { color } : {}),
        }
      : { name: typed, color };
    if (Object.keys(body).length === 0) return onDone();
    save.mutate(body);
  };

  const nameId = `${formId}-name`;
  return (
    <form
      className="grid gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <FormBanner message={banner} />
      <div className="grid gap-1.5">
        <Label htmlFor={nameId}>{t("name")}</Label>
        <Input
          id={nameId}
          value={name}
          maxLength={30}
          autoFocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${nameId}-message` : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
        />
        {error ? (
          <p id={`${nameId}-message`} role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-sm font-medium text-text-700">{t("color")}</legend>
        <div className="flex flex-wrap gap-2">
          {[...TAG_COLORS.map((c) => ({ hex: c.hex as string | null, key: c.name })), { hex: null, key: "none" }].map(
            (c) => (
              <label key={c.key} className="relative cursor-pointer">
                <input
                  type="radio"
                  name={`${formId}-color`}
                  checked={color === c.hex}
                  onChange={() => setColor(c.hex)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden
                  className={cn(
                    "block size-7 rounded-full ring-2 ring-transparent ring-offset-2 ring-offset-surface peer-checked:ring-text-900 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-ring",
                    c.hex === null && "border-2 border-dashed border-border-strong bg-surface",
                  )}
                  style={c.hex ? { backgroundColor: c.hex } : undefined}
                />
                <span className="sr-only">{t(`color_${c.key as (typeof TAG_COLORS)[number]["name"] | "none"}`)}</span>
              </label>
            ),
          )}
        </div>
      </fieldset>
      <span className="flex gap-2">
        <Button type="submit" size="sm" loading={save.isPending}>
          {tag ? tCommon("save") : t("addSubmit")}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onDone}>
          {tCommon("cancel")}
        </Button>
      </span>
    </form>
  );
}
