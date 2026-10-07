import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl, testRouter } from "@/test/navigation";
import { mockApi, problem, renderApp, testMe } from "@/test/render";
import { LoginForm } from "./login-form";

const CHALLENGE = "c".repeat(43);
const needsCode = () =>
  problem(401, "auth.two_factor_required", "Masukkan kode dari aplikasi autentikator untuk menyelesaikan masuk.", {
    challenge: CHALLENGE,
    expires_in: 300,
  });

async function enterPassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Email"), "rina@example.test");
  await user.type(screen.getByLabelText("Kata sandi"), "rahasia-sekali");
  await user.click(screen.getByRole("button", { name: "Masuk" }));
}

describe("LoginForm", () => {
  beforeEach(() => setUrl("/masuk?next=%2Fpesanan%3Fstatus%3Dnew"));

  it("asks which business when the email belongs to several, then signs in to that one", async () => {
    const calls = mockApi({
      "POST /v1/auth/login": (call) =>
        (call.body as { tenant?: string }).tenant
          ? testMe()
          : problem(409, "auth.tenant_choice_required", "Pilih bisnis.", {
              tenants: [
                { slug: "toko-rina", name: "Toko Rina" },
                { slug: "grosir-rina", name: "Grosir Rina" },
              ],
            }),
    });
    const user = userEvent.setup();
    renderApp(<LoginForm />);

    await user.type(screen.getByLabelText("Email"), "rina@example.test");
    await user.type(screen.getByLabelText("Kata sandi"), "rahasia-sekali");
    await user.click(screen.getByRole("button", { name: "Masuk" }));

    await user.click(await screen.findByRole("radio", { name: "Grosir Rina" }));
    await user.click(screen.getByRole("button", { name: "Masuk" }));

    await waitFor(() => expect(testRouter.replace).toHaveBeenCalledWith("/pesanan?status=new"));
    expect(calls.map((c) => c.body)).toEqual([
      { email: "rina@example.test", password: "rahasia-sekali" },
      { email: "rina@example.test", password: "rahasia-sekali", tenant: "grosir-rina" },
    ]);
  });

  it("never follows a next link to another site", async () => {
    setUrl("/masuk?next=%2F%2Fevil.example");
    mockApi({ "POST /v1/auth/login": () => testMe() });
    const user = userEvent.setup();
    renderApp(<LoginForm />);
    await user.type(screen.getByLabelText("Email"), "rina@example.test");
    await user.type(screen.getByLabelText("Kata sandi"), "rahasia-sekali");
    await user.click(screen.getByRole("button", { name: "Masuk" }));
    await waitFor(() => expect(testRouter.replace).toHaveBeenCalledWith("/"));
  });

  it("shows a wrong password as the api says it", async () => {
    mockApi({ "POST /v1/auth/login": () => problem(401, "auth.invalid_credentials", "Email atau kata sandi salah.") });
    const user = userEvent.setup();
    renderApp(<LoginForm />);
    await user.type(screen.getByLabelText("Email"), "rina@example.test");
    await user.type(screen.getByLabelText("Kata sandi"), "salah");
    await user.click(screen.getByRole("button", { name: "Masuk" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email atau kata sandi salah.");
    expect(testRouter.replace).not.toHaveBeenCalled();
  });

  it("asks the authenticator code after the password, sends it once six digits are in, and takes a retry", async () => {
    const calls = mockApi({
      "POST /v1/auth/login": needsCode,
      "POST /v1/auth/login/two-factor": (call) =>
        (call.body as { code?: string }).code === "123456"
          ? testMe()
          : problem(401, "auth.two_factor_invalid", "Kode salah atau sudah dipakai. Coba kode yang baru."),
    });
    const user = userEvent.setup();
    renderApp(<LoginForm />);
    await enterPassword(user);

    expect(await screen.findByRole("heading", { name: "Verifikasi dua langkah" })).toBeInTheDocument();
    const code = screen.getByLabelText("Kode verifikasi");
    await user.type(code, "654321");
    expect(await screen.findByRole("alert")).toHaveTextContent("Kode salah atau sudah dipakai.");
    await waitFor(() => expect(code).toHaveValue(""));
    await user.type(code, "123456");
    await waitFor(() => expect(testRouter.replace).toHaveBeenCalledWith("/pesanan?status=new"));
    expect(calls.filter((c) => c.path === "/v1/auth/login/two-factor").map((c) => c.body)).toEqual([
      { challenge: CHALLENGE, code: "654321" },
      { challenge: CHALLENGE, code: "123456" },
    ]);
  });

  it("signs in with a backup code and says how many are left", async () => {
    const calls = mockApi({
      "POST /v1/auth/login": needsCode,
      "POST /v1/auth/login/two-factor": () => testMe(),
      "GET /v1/me/two-factor": () => ({
        enabled: true,
        enabledAt: "2026-10-01T00:00:00.000Z",
        backupCodesLeft: 2,
        recommended: true,
      }),
    });
    const user = userEvent.setup();
    renderApp(<LoginForm />);
    await enterPassword(user);
    await user.click(await screen.findByRole("button", { name: "Pakai kode cadangan" }));
    expect(screen.getByText(/Masukkan salah satu kode cadangan/)).toBeInTheDocument();
    // nothing typed: said here, not asked of the api
    await user.click(screen.getByRole("button", { name: "Verifikasi" }));
    expect(await screen.findByText("Masukkan kode cadangan.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Kode cadangan"), " k7m2q-x9p4w ");
    await user.click(screen.getByRole("button", { name: "Verifikasi" }));
    await waitFor(() => expect(testRouter.replace).toHaveBeenCalledWith("/pesanan?status=new"));
    expect(calls.find((c) => c.path === "/v1/auth/login/two-factor")?.body).toEqual({
      challenge: CHALLENGE,
      backupCode: "k7m2q-x9p4w",
    });
    expect(await screen.findByText(/Anda masuk dengan kode cadangan\. Sisa 2 kode/)).toBeInTheDocument();
  });

  it("starts again from the password when the code step ran out, keeping the email", async () => {
    mockApi({
      "POST /v1/auth/login": needsCode,
      "POST /v1/auth/login/two-factor": () =>
        problem(
          401,
          "auth.two_factor_expired",
          "Waktu untuk memasukkan kode sudah habis atau kode salah terlalu sering. Masuk lagi dengan email dan kata sandi.",
        ),
    });
    const user = userEvent.setup();
    renderApp(<LoginForm />);
    await enterPassword(user);
    await user.type(await screen.findByLabelText("Kode verifikasi"), "111111");
    expect(await screen.findByRole("heading", { name: "Masuk ke OmniSeller" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Waktu untuk memasukkan kode sudah habis");
    expect(screen.getByLabelText("Email")).toHaveValue("rina@example.test");
    expect(screen.getByLabelText("Kata sandi")).toHaveValue("");

    // and back by hand
    await user.type(screen.getByLabelText("Kata sandi"), "rahasia-sekali");
    await user.click(screen.getByRole("button", { name: "Masuk" }));
    await user.click(await screen.findByRole("button", { name: "Kembali ke halaman masuk" }));
    expect(await screen.findByRole("heading", { name: "Masuk ke OmniSeller" })).toBeInTheDocument();
    expect(testRouter.replace).not.toHaveBeenCalled();
  });
});
