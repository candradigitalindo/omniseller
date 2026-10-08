import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, renderApp, testMe } from "@/test/render";
import { SignupForm } from "./signup-form";

const agreement = "Saya menyetujui syarat layanan dan kebijakan privasi OmniSeller.";

describe("SignupForm", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("links the terms and the privacy policy on the public site, opened beside the form", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://omniseller.example/");
    mockApi({});
    renderApp(<SignupForm />);
    // the checkbox keeps the whole sentence as its name
    expect(screen.getByRole("checkbox", { name: agreement })).toBeInTheDocument();
    const terms = screen.getByRole("link", { name: "syarat layanan" });
    expect(terms).toHaveAttribute("href", "https://omniseller.example/syarat-layanan/");
    expect(terms).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "kebijakan privasi" })).toHaveAttribute(
      "href",
      "https://omniseller.example/kebijakan-privasi/",
    );
  });

  it("names the documents without links where there is no public site, and needs the agreement", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    const calls = mockApi({ "POST /v1/auth/signup": () => testMe() });
    const user = userEvent.setup();
    renderApp(<SignupForm />);
    expect(screen.getByRole("checkbox", { name: agreement })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "syarat layanan" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Nama bisnis"), "Toko Rina");
    await user.type(screen.getByLabelText("Nama Anda"), "Rina");
    await user.type(screen.getByLabelText("Email"), "rina@example.test");
    await user.type(screen.getByLabelText("Kata sandi"), "kata-sandi-kuat-123");
    await user.click(screen.getByRole("button", { name: "Daftar" }));
    expect(await screen.findByText("Setujui syarat layanan untuk melanjutkan.")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/v1/auth/signup")).toHaveLength(0);

    await user.click(screen.getByRole("checkbox", { name: agreement }));
    await user.click(screen.getByRole("button", { name: "Daftar" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/v1/auth/signup")).toHaveLength(1));
    expect(calls.find((c) => c.path === "/v1/auth/signup")?.body).toEqual({
      businessName: "Toko Rina",
      name: "Rina",
      email: "rina@example.test",
      password: "kata-sandi-kuat-123",
    });
  });
});
