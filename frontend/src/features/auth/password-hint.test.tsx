import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import messages from "../../../messages/id.json";
import { PasswordHint } from "./password-hint";

const hint = (password: string) =>
  render(
    <NextIntlClientProvider locale="id" messages={messages}>
      <PasswordHint password={password} />
    </NextIntlClientProvider>,
  );

describe("password hint", () => {
  it("states the rule until something is typed, then rates it", () => {
    hint("");
    expect(screen.getByText("Minimal 10 karakter.")).toBeInTheDocument();
  });

  it.each([
    ["pendek", "lemah"],
    ["katasandipanjang1", "cukup"],
    ["Sandi-Baru-2026!", "kuat"],
  ])("rates %s as %s", (password, level) => {
    hint(password);
    expect(screen.getByText(`Kekuatan: ${level}`)).toBeInTheDocument();
  });
});
