import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
    const { rerender } = render(<Choice value="pdf" options={["pdf"]} onValueChange={onValueChange} />);
    // a list loaded later: the remembered choice and its option show up in the same render
    rerender(<Choice value="agen" options={["pdf", "agen"]} onValueChange={onValueChange} />);
    expect(onValueChange).not.toHaveBeenCalledWith("");
    expect(screen.getByRole("combobox", { name: "Pilihan" })).toHaveTextContent("agen");
  });
});
