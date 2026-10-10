"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { meQueryKey } from "@/lib/session";
import { namesMatch } from "./closure-meta";

const FALLBACK_DAYS = 30;

/**
 * L47 "Tutup akun bisnis" (backend doc 8.36): what closing does, and the dialog that does it with the
 * business's name and the user's password typed again. Once closed, the shell shows L54 instead of the app.
 */
export function ClosureCard({ businessName }: { businessName: string }) {
  const t = useTranslations("closure");
  const [open, setOpen] = useState(false);
  const closure = useQuery({
    queryKey: ["account-closure"],
    queryFn: () => unwrap(api.GET("/v1/account-closure")),
  });
  const days = closure.data?.purgeAfterDays ?? FALLBACK_DAYS;
  return (
    <Card className="border-danger/40">
      <CardHeader>
        <CardTitle>
          <h2>{t("cardTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("cardBody", { days })}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          {t("close")}
        </Button>
      </CardContent>
      {open ? <CloseDialog name={businessName} days={days} onClose={() => setOpen(false)} /> : null}
    </Card>
  );
}

function CloseDialog({ name, days, onClose }: { name: string; days: number; onClose: () => void }) {
  const t = useTranslations("closure");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const close = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/account-closure", { body: { businessName: typed, password } })),
    onSuccess: (closure) => {
      // the closing page reads this at once: not what this card read while the account was open
      queryClient.setQueryData(["account-closure"], closure);
      // the shell shows the closing page from the session's status
      return queryClient.invalidateQueries({ queryKey: meQueryKey });
    },
  });
  const failed = close.error instanceof ApiError ? close.error : null;
  const nameProblem = failed?.fieldMessage("businessName");
  const passwordProblem = failed?.fieldMessage("password");
  const general = close.error && !nameProblem && !passwordProblem ? errorMessage(close.error) : null;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle", { name })}</DialogTitle>
          <DialogDescription>{t("dialogBody", { days })}</DialogDescription>
        </DialogHeader>
        <form
          id="close-account"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            close.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="close-name">{t("nameLabel", { name })}</Label>
            <Input
              id="close-name"
              value={typed}
              autoComplete="off"
              aria-invalid={nameProblem ? true : undefined}
              aria-describedby={nameProblem ? "close-name-problem" : undefined}
              onChange={(e) => setTyped(e.target.value)}
            />
            {nameProblem ? (
              <p id="close-name-problem" className="text-sm text-danger">
                {nameProblem}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="close-password">{t("passwordLabel")}</Label>
            <Input
              id="close-password"
              type="password"
              value={password}
              autoComplete="current-password"
              aria-invalid={passwordProblem ? true : undefined}
              aria-describedby={passwordProblem ? "close-password-problem" : undefined}
              onChange={(e) => setPassword(e.target.value)}
            />
            {passwordProblem ? (
              <p id="close-password-problem" className="text-sm text-danger">
                {passwordProblem}
              </p>
            ) : null}
          </div>
          {general ? (
            <p role="alert" className="text-sm text-danger">
              {general}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button
            type="submit"
            form="close-account"
            variant="destructive"
            loading={close.isPending}
            disabled={!namesMatch(typed, name) || password === ""}
          >
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
