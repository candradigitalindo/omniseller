import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockApi, renderApp } from "@/test/render";
import { UserMenu } from "./user-menu";

describe("profile menu (DOKUMEN-UI-UX 7.1)", () => {
  it("leads to the account page", async () => {
    mockApi({});
    const user = userEvent.setup();
    renderApp(<UserMenu showName />);
    await user.click(screen.getByRole("button", { name: "Rina Wulandari" }));
    expect(await screen.findByRole("menuitem", { name: "Akun saya" })).toHaveAttribute("href", "/akun");
    expect(screen.getByRole("menuitem", { name: "Keluar" })).toBeInTheDocument();
  });
});
