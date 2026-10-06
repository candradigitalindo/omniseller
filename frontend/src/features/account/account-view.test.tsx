import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type ApiCall, mockApi, problem, renderApp } from "@/test/render";
import { AccountView } from "./account-view";

const sent = (calls: ApiCall[]) => calls.filter((c) => c.path === "/v1/me/password");

async function fill(user: ReturnType<typeof userEvent.setup>, current: string, next: string, again = next) {
  if (current) await user.type(screen.getByLabelText("Kata sandi saat ini"), current);
  if (next) await user.type(screen.getByLabelText("Kata sandi baru"), next);
  if (again) await user.type(screen.getByLabelText("Ulangi kata sandi baru"), again);
  await user.click(screen.getByRole("button", { name: "Simpan kata sandi baru" }));
}

describe("Akun saya", () => {
  it("shows who is signed in", () => {
    mockApi({});
    renderApp(<AccountView />);
    expect(screen.getByRole("heading", { name: "Profil" })).toBeInTheDocument();
    expect(screen.getByText("Rina Wulandari")).toBeInTheDocument();
    expect(screen.getByText("rina@example.test")).toBeInTheDocument();
    expect(screen.getByText("Toko Rina")).toBeInTheDocument();
    expect(screen.getByText("Pemilik")).toBeInTheDocument();
  });

  it("changes the password, then clears the form and says other devices were signed out", async () => {
    const calls = mockApi({ "POST /v1/me/password": () => new Response(null, { status: 204 }) });
    const user = userEvent.setup();
    renderApp(<AccountView />);
    expect(screen.getByText("Minimal 10 karakter.")).toBeInTheDocument();
    await fill(user, "sandi-lama-123", "Sandi-Baru-2026!");

    await waitFor(() => expect(sent(calls)).toHaveLength(1));
    expect(sent(calls)[0]?.body).toEqual({ currentPassword: "sandi-lama-123", newPassword: "Sandi-Baru-2026!" });
    expect(await screen.findByText("Kata sandi diganti. Perangkat lain sudah dikeluarkan.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Kata sandi saat ini")).toHaveValue(""));
    expect(screen.getByLabelText("Kata sandi baru")).toHaveValue("");
  });

  it("checks the new password before asking the api", async () => {
    const calls = mockApi({});
    const user = userEvent.setup();
    renderApp(<AccountView />);
    await fill(user, "", "pendek", "pendek");
    expect(await screen.findByText("Isi kata sandi saat ini.")).toBeInTheDocument();
    expect(screen.getByText("Minimal 10 karakter.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Kata sandi baru"));
    await user.clear(screen.getByLabelText("Ulangi kata sandi baru"));
    await fill(user, "sandi-lama-123", "Sandi-Baru-2026!", "Sandi-Baru-2027!");
    expect(await screen.findByText("Kedua kata sandi tidak sama.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Kata sandi saat ini"));
    await user.clear(screen.getByLabelText("Kata sandi baru"));
    await user.clear(screen.getByLabelText("Ulangi kata sandi baru"));
    await fill(user, "Sandi-Lama-2026!", "Sandi-Lama-2026!");
    expect(await screen.findByText("Kata sandi baru harus berbeda dari yang sekarang.")).toBeInTheDocument();
    expect(sent(calls)).toHaveLength(0);
  });

  it("shows a wrong current password on its own field", async () => {
    mockApi({
      "POST /v1/me/password": () =>
        problem(422, "validation.failed", "Data tidak valid.", {
          errors: [{ path: "currentPassword", message: "Kata sandi saat ini salah." }],
        }),
    });
    const user = userEvent.setup();
    renderApp(<AccountView />);
    await fill(user, "salah-sekali-1", "Sandi-Baru-2026!");
    expect(await screen.findByText("Kata sandi saat ini salah.")).toBeInTheDocument();
    expect(screen.getByLabelText("Kata sandi saat ini")).toHaveAttribute("aria-invalid", "true");
  });
});
