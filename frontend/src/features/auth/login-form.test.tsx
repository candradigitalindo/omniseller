import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl, testRouter } from "@/test/navigation";
import { mockApi, problem, renderApp, testMe } from "@/test/render";
import { LoginForm } from "./login-form";

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
});
