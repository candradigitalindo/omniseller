import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { mockApi, renderApp } from "@/test/render";
import { SELECTION_BAR_HEIGHT, SelectionBar } from "./selection-bar";

describe("selection bar", () => {
  it("names the actions for what is chosen, says how many, and is what the app shell makes room for", () => {
    mockApi({});
    renderApp(
      <SelectionBar count="3 dipilih">
        <Button size="sm">Terima</Button>
      </SelectionBar>,
    );
    const bar = screen.getByRole("toolbar", { name: "Aksi untuk yang dipilih" });
    expect(within(bar).getByText("3 dipilih")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Terima" })).toBeInTheDocument();
    // app-shell.tsx: `has-[[data-slot=selection-bar]]` leaves room under the page on phones
    expect(bar).toHaveAttribute("data-slot", "selection-bar");
    expect(bar.className).toContain("max-md:fixed");
  });

  it("tells the app shell how tall it is while shown, so the page keeps room for the last rows", () => {
    let report: () => void = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          report = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(130);
    mockApi({});
    const { unmount } = renderApp(
      <SelectionBar count="1 dipilih">
        <Button size="sm">Terima</Button>
      </SelectionBar>,
    );
    report();
    expect(document.documentElement.style.getPropertyValue(SELECTION_BAR_HEIGHT)).toBe("130px");
    unmount();
    expect(document.documentElement.style.getPropertyValue(SELECTION_BAR_HEIGHT)).toBe("");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
