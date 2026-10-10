import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockApi, problem, renderApp } from "@/test/render";
import { ClosingView } from "./closing-view";
import { ClosureCard } from "./closure-card";

const OPEN = {
  status: "active",
  closingAt: null,
  purgeAfter: null,
  closedBy: null,
  revokeLinks: [],
  purgeAfterDays: 30,
};

describe("ClosureCard (L47)", () => {
  it("says what closing does, and closes only with the name and the password typed again", async () => {
    const calls = mockApi({
      "GET /v1/account-closure": () => OPEN,
      "POST /v1/account-closure": () => ({ ...OPEN, status: "closing" }),
    });
    const user = userEvent.setup();
    renderApp(<ClosureCard businessName="Toko Rina" />);
    expect(await screen.findByText(/Selama 30 hari Anda masih bisa masuk/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tutup akun bisnis" }));
    const dialog = screen.getByRole("dialog", { name: "Tutup akun Toko Rina?" });
    const confirm = within(dialog).getByRole("button", { name: "Tutup akun" });
    expect(confirm).toBeDisabled();
    const nameBox = within(dialog).getByLabelText("Ketik nama bisnis: Toko Rina");
    await user.type(nameBox, "Toko Rini");
    await user.type(within(dialog).getByLabelText("Kata sandi Anda"), "rahasia-kuat");
    // another name never closes it, whatever the password
    expect(confirm).toBeDisabled();
    await user.clear(nameBox);
    await user.type(nameBox, "toko  rina");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      businessName: "toko  rina",
      password: "rahasia-kuat",
    });
  });

  it("shows the api's word on the field it refused", async () => {
    mockApi({
      "GET /v1/account-closure": () => OPEN,
      "POST /v1/account-closure": () =>
        problem(422, "validation.failed", "Data tidak valid.", {
          errors: [{ path: "password", message: "Kata sandi salah." }],
        }),
    });
    const user = userEvent.setup();
    renderApp(<ClosureCard businessName="Toko Rina" />);
    await user.click(await screen.findByRole("button", { name: "Tutup akun bisnis" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Ketik nama bisnis: Toko Rina"), "Toko Rina");
    await user.type(within(dialog).getByLabelText("Kata sandi Anda"), "salah");
    await user.click(within(dialog).getByRole("button", { name: "Tutup akun" }));
    expect(await within(dialog).findByText("Kata sandi salah.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Kata sandi Anda")).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("hands the closing page what the api answered, not what it read while the account was open", async () => {
    const purgeAfter = new Date(Date.now() + 30 * 86_400_000).toISOString();
    mockApi({
      // read once while open; the closure itself answers with the dates
      "GET /v1/account-closure": () => OPEN,
      "GET /v1/exports": () => ({ items: [] }),
      "POST /v1/account-closure": () => ({
        ...OPEN,
        status: "closing",
        closingAt: new Date().toISOString(),
        purgeAfter,
        closedBy: { id: "01JUSER0000000000000000001", name: "Rina Wulandari" },
      }),
    });
    const user = userEvent.setup();
    renderApp(
      <>
        <ClosureCard businessName="Toko Rina" />
        <ClosingView />
      </>,
    );
    await user.click(await screen.findByRole("button", { name: "Tutup akun bisnis" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Ketik nama bisnis: Toko Rina"), "Toko Rina");
    await user.type(within(dialog).getByLabelText("Kata sandi Anda"), "rahasia-kuat");
    await user.click(within(dialog).getByRole("button", { name: "Tutup akun" }));
    expect(await screen.findByText(/Seluruh data bisnis akan dihapus pada .+ \(30 hari lagi\)\./)).toBeInTheDocument();
    expect(screen.getByText(/Ditutup oleh Rina Wulandari/)).toBeInTheDocument();
  });
});
