import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { setUrl } from "@/test/navigation";
import { renderApp, testMe } from "@/test/render";
import { AppSidebar } from "./app-sidebar";

describe("sidebar categories", () => {
  it("opens the current category, supports keyboard toggles, and follows navigation", async () => {
    setUrl("/tim");
    const user = userEvent.setup();
    renderApp(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>,
    );
    const access = screen.getByRole("button", { name: "Tim & Akses" });
    expect(access).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Tim & Peran" })).toHaveAttribute("aria-current", "page");
    const stock = screen.getByRole("button", { name: "Stok & Gudang" });
    expect(stock).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Stock Opname" })).not.toBeInTheDocument();
    stock.focus();
    await user.keyboard("{Enter}");
    expect(stock).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Stock Opname" })).toBeVisible();
    await user.click(stock);
    act(() => setUrl("/stok/opname"));
    expect(screen.getByRole("button", { name: "Stok & Gudang" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Stock Opname" })).toHaveAttribute("aria-current", "page");
  });

  it("shows categories from a tenant's custom role permissions on Starter", () => {
    setUrl("/pesanan");
    const me = {
      ...testMe(["order:read"]),
      plan: { code: "starter", name: "Starter", features: [] },
      roles: [{ id: "custom", name: "Shift Pagi" }],
    };
    renderApp(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>,
      { me },
    );
    expect(screen.getByRole("button", { name: "Penjualan" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Pesanan" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Tim & Akses" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bisnis & Integrasi" })).not.toBeInTheDocument();
  });
});
