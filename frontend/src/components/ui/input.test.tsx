import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";
import { Input } from "./input";

function Controlled({
  type,
  currency,
  initial = "",
}: {
  type?: "date" | "time" | "datetime-local";
  currency?: boolean;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <Input
        aria-label="Nilai"
        type={type}
        currency={currency}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <output aria-label="Nilai API">{value}</output>
    </>
  );
}
describe("Localized inputs", () => {
  it("formats money while typing, clearing, and pasting without changing its canonical value", async () => {
    const user = userEvent.setup();
    renderApp(<Controlled currency />);
    const input = screen.getByRole("textbox", { name: "Nilai" });
    await user.type(input, "1250000");
    expect(input).toHaveValue("1.250.000");
    expect(screen.getByRole("status", { name: "Nilai API" })).toHaveTextContent("1250000");
    await user.clear(input);
    expect(input).toHaveValue("");
    await user.paste("Rp 75.000");
    expect(input).toHaveValue("75.000");
    expect(screen.getByRole("status", { name: "Nilai API" })).toHaveTextContent("75000");
  });
  it("does not silently turn fractional money into a different integer amount", async () => {
    renderApp(<Controlled currency />);
    await userEvent.setup().type(screen.getByRole("textbox", { name: "Nilai" }), "12,50");
    expect(screen.getByRole("status", { name: "Nilai API" })).toHaveTextContent("12,50");
    expect(screen.getByRole("textbox", { name: "Nilai" })).toBeInvalid();
  });
  it("toggles password visibility without changing the value", async () => {
    renderApp(<Input aria-label="Kata sandi" type="password" defaultValue="kata-sandi" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Tampilkan sandi" }));
    expect(screen.getByLabelText("Kata sandi")).toHaveAttribute("type", "text");
    await userEvent.setup().click(screen.getByRole("button", { name: "Sembunyikan sandi" }));
    expect(screen.getByLabelText("Kata sandi")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Kata sandi")).toHaveValue("kata-sandi");
  });
  it("accepts Indonesian dates, retains ISO form state, and rejects impossible dates on blur", async () => {
    const user = userEvent.setup();
    renderApp(<Controlled type="date" initial="2026-10-05" />);
    const input = screen.getByRole("textbox", { name: "Nilai" });
    expect(input).toHaveValue("05/10/2026");
    await user.clear(input);
    await user.type(input, "06/10/2026");
    expect(screen.getByRole("status", { name: "Nilai API" })).toHaveTextContent("2026-10-06");
    fireEvent.change(input, { target: { value: "31/02/2026" } });
    fireEvent.blur(input);
    expect(input).toBeInvalid();
    expect(screen.getByRole("alert")).toHaveTextContent("Gunakan tanggal yang valid");
  });
  it("uses a calendar modal with a searchable month and keeps the current value when canceled", async () => {
    const user = userEvent.setup();
    renderApp(<Controlled type="date" initial="2026-10-05" />);
    await user.click(screen.getByRole("button", { name: "Pilih tanggal" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "6 Oktober 2026" }));
    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    expect(screen.getByRole("textbox", { name: "Nilai" })).toHaveValue("05/10/2026");
    await user.click(screen.getByRole("button", { name: "Pilih tanggal" }));
    await user.click(screen.getByRole("button", { name: "6 Oktober 2026" }));
    await user.click(screen.getByRole("button", { name: "Gunakan pilihan" }));
    expect(screen.getByRole("status", { name: "Nilai API" })).toHaveTextContent("2026-10-06");
    expect(screen.getByRole("textbox", { name: "Nilai" })).toHaveFocus();
  });
});
