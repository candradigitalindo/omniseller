import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render";
import messages from "../../../messages/id.json";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

function Choice({
  value,
  options,
  onValueChange,
}: {
  value: string;
  options: string[];
  onValueChange: (v: string) => void;
}) {
  return (
    <form>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger aria-label="Pilihan">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </form>
  );
}

describe("Select", () => {
  it("never reports an empty choice when its value and option arrive together inside a form", () => {
    const onValueChange = vi.fn();
    const { rerender } = render(<Choice value="pdf" options={["pdf"]} onValueChange={onValueChange} />, {
      wrapper: ({ children }) => (
        <NextIntlClientProvider locale="id" messages={messages}>
          {children}
        </NextIntlClientProvider>
      ),
    });
    // a list loaded later: the remembered choice and its option show up in the same render
    rerender(<Choice value="agen" options={["pdf", "agen"]} onValueChange={onValueChange} />);
    expect(onValueChange).not.toHaveBeenCalledWith("");
    expect(screen.getByRole("combobox", { name: "Pilihan" })).toHaveTextContent("agen");
  });
  it("searches visible labels and selects with the keyboard, then returns focus", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    renderApp(<Choice value="JNE" options={["JNE", "J&T Express", "SiCepat"]} onValueChange={onValueChange} />);
    const trigger = screen.getByRole("combobox", { name: "Pilihan" });
    await user.click(trigger);
    const search = screen.getByRole("searchbox", { name: "Cari pilihan…" });
    expect(search).toHaveFocus();
    await user.type(search, "express");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onValueChange).toHaveBeenCalledWith("J&T Express");
    expect(trigger).toHaveFocus();
  });
  it("shows an empty result, allows clearing the search, and closes on Escape without changing the choice", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    renderApp(<Choice value="JNE" options={["JNE", "SiCepat"]} onValueChange={onValueChange} />);
    await user.click(screen.getByRole("combobox", { name: "Pilihan" }));
    const search = screen.getByRole("searchbox");
    await user.type(search, "tidak ada");
    expect(screen.getByRole("status")).toHaveTextContent("Tidak ada pilihan yang cocok.");
    await user.clear(search);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
