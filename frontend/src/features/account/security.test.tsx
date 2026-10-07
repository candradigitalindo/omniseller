import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type ApiCall, mockApi, problem, renderApp } from "@/test/render";
import { SessionsCard } from "./sessions-card";
import { TwoFactorCard } from "./two-factor-card";

const CODES = [
  "abcde-fghjk",
  "mnpqr-stuvw",
  "xyz23-45678",
  "9abcd-efghj",
  "kmnpq-rstuv",
  "wxyz2-34567",
  "89abc-defgh",
  "jkmnp-qrstu",
  "vwxyz-23456",
  "789ab-cdefg",
];
const OFF = { enabled: false, enabledAt: null, backupCodesLeft: 0, recommended: true };
const ON = { enabled: true, enabledAt: "2026-10-01T03:00:00.000Z", backupCodesLeft: 2, recommended: true };
const wrongPassword = () =>
  problem(422, "validation.failed", "Periksa kembali isian yang ditandai.", {
    errors: [{ path: "password", message: "Kata sandi salah." }],
  });
const posted = (calls: ApiCall[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

describe("Verifikasi dua langkah (L41b)", () => {
  it("turns on with the password, the QR code and a code from the app, then shows the backup codes once", async () => {
    let state: typeof OFF | typeof ON = OFF;
    const calls = mockApi({
      "GET /v1/me/two-factor": () => state,
      "POST /v1/me/two-factor/setup": (c) =>
        (c.body as { password: string }).password === "sandi-benar-123"
          ? {
              secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
              uri: "otpauth://totp/OmniSeller:rina%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=OmniSeller",
              qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><path d="M0 0h7v7H0z"/></svg>',
            }
          : wrongPassword(),
      "POST /v1/me/two-factor/enable": () => {
        state = { ...ON, backupCodesLeft: 10 };
        return { backupCodes: CODES };
      },
    });
    const user = userEvent.setup();
    renderApp(<TwoFactorCard />);
    expect(await screen.findByText("Belum aktif")).toBeInTheDocument();
    expect(screen.getByText(/Dianjurkan untuk Owner dan Admin/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Aktifkan" }));
    const dialog = await screen.findByRole("dialog", { name: "Aktifkan verifikasi dua langkah" });
    await user.click(within(dialog).getByRole("button", { name: "Lanjut" }));
    expect(within(dialog).getByText("Isi kata sandi.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Kata sandi"), "salah-sekali-1");
    await user.click(within(dialog).getByRole("button", { name: "Lanjut" }));
    expect(await within(dialog).findByText("Kata sandi salah.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Kata sandi"));
    await user.type(within(dialog).getByLabelText("Kata sandi"), "sandi-benar-123");
    await user.click(within(dialog).getByRole("button", { name: "Lanjut" }));

    const qr = await within(dialog).findByRole("img", { name: "Kode QR untuk aplikasi autentikator" });
    expect(qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
    expect(within(dialog).getByText("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP")).toBeInTheDocument();
    // six digits go at once
    await user.type(within(dialog).getByLabelText("Kode 6 angka dari aplikasi"), "123456");

    const list = await within(dialog).findByRole("list", { name: "Kode cadangan" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(CODES);
    expect(posted(calls, "/v1/me/two-factor/enable")[0]?.body).toEqual({ code: "123456" });
    expect(await screen.findByText(/Verifikasi dua langkah aktif\. Perangkat lain/)).toBeInTheDocument();
    // the codes are shown once: closing waits until they are kept
    const done = within(dialog).getByRole("button", { name: "Selesai" });
    expect(done).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText("Saya sudah menyimpan kode ini"));
    await user.click(done);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Aktif")).toBeInTheDocument();
    expect(screen.getByText("Sisa kode cadangan: 10")).toBeInTheDocument();
  });

  it("says the code was wrong and lets the user try another", async () => {
    mockApi({
      "GET /v1/me/two-factor": () => OFF,
      "POST /v1/me/two-factor/setup": () => ({
        secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        uri: "otpauth://totp/x",
        qrSvg: "<svg/>",
      }),
      "POST /v1/me/two-factor/enable": () =>
        problem(422, "validation.failed", "Periksa kembali isian yang ditandai.", {
          errors: [
            { path: "code", message: "Kode tidak cocok. Pastikan jam di ponsel tepat, lalu coba kode yang baru." },
          ],
        }),
    });
    const user = userEvent.setup();
    renderApp(<TwoFactorCard />);
    await user.click(await screen.findByRole("button", { name: "Aktifkan" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Kata sandi"), "sandi-benar-123");
    await user.click(within(dialog).getByRole("button", { name: "Lanjut" }));
    const code = await within(dialog).findByLabelText("Kode 6 angka dari aplikasi");
    await user.type(code, "999999");
    expect(await within(dialog).findByText(/Kode tidak cocok\. Pastikan jam di ponsel tepat/)).toBeInTheDocument();
    await waitFor(() => expect(code).toHaveValue(""));
  });

  it("warns when backup codes run low, and makes new ones after the password", async () => {
    const calls = mockApi({
      "GET /v1/me/two-factor": () => ON,
      "POST /v1/me/two-factor/backup-codes": () => ({ backupCodes: CODES }),
    });
    const user = userEvent.setup();
    renderApp(<TwoFactorCard />);
    expect(await screen.findByText("Aktif sejak 1 Okt 2026")).toBeInTheDocument();
    expect(screen.getByText("Sisa kode cadangan: 2")).toBeInTheDocument();
    expect(screen.getByText(/Kode cadangan hampir habis/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Buat kode cadangan baru" }));
    const dialog = await screen.findByRole("dialog", { name: "Buat kode cadangan baru" });
    await user.type(within(dialog).getByLabelText("Kata sandi"), "sandi-benar-123");
    await user.click(within(dialog).getByRole("button", { name: "Lanjut" }));
    expect(await within(dialog).findByRole("list", { name: "Kode cadangan" })).toHaveTextContent("abcde-fghjk");
    expect(posted(calls, "/v1/me/two-factor/backup-codes")[0]?.body).toEqual({ password: "sandi-benar-123" });
    await user.click(within(dialog).getByRole("button", { name: "Salin semua" }));
    expect(await screen.findByText("Kode cadangan disalin.")).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toContain("abcde-fghjk\nmnpqr-stuvw");
  });

  it("turns off with the password and a code, or a backup code instead", async () => {
    let state: typeof ON | typeof OFF = ON;
    const calls = mockApi({
      "GET /v1/me/two-factor": () => state,
      "POST /v1/me/two-factor/disable": (c) => {
        if ((c.body as { backupCode?: string }).backupCode !== "abcde-fghjk") {
          return problem(422, "validation.failed", "Periksa kembali isian yang ditandai.", {
            errors: [{ path: "backupCode", message: "Kode cadangan tidak cocok atau sudah dipakai." }],
          });
        }
        state = OFF;
        return undefined;
      },
    });
    const user = userEvent.setup();
    renderApp(<TwoFactorCard />);
    await user.click(await screen.findByRole("button", { name: "Matikan" }));
    const dialog = await screen.findByRole("dialog", { name: "Matikan verifikasi dua langkah?" });
    await user.click(within(dialog).getByRole("button", { name: "Matikan" }));
    expect(within(dialog).getByText("Isi kata sandi.")).toBeInTheDocument();
    expect(within(dialog).getByText("Masukkan 6 angka dari aplikasi.")).toBeInTheDocument();
    expect(posted(calls, "/v1/me/two-factor/disable")).toHaveLength(0);

    await user.type(within(dialog).getByLabelText("Kata sandi"), "sandi-benar-123");
    await user.click(within(dialog).getByRole("button", { name: "Pakai kode cadangan" }));
    await user.type(within(dialog).getByLabelText("Kode cadangan"), "zzzzz-zzzzz");
    await user.click(within(dialog).getByRole("button", { name: "Matikan" }));
    expect(await within(dialog).findByText("Kode cadangan tidak cocok atau sudah dipakai.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Kode cadangan"));
    await user.type(within(dialog).getByLabelText("Kode cadangan"), "abcde-fghjk");
    await user.click(within(dialog).getByRole("button", { name: "Matikan" }));
    expect(await screen.findByText("Verifikasi dua langkah dimatikan.")).toBeInTheDocument();
    expect(posted(calls, "/v1/me/two-factor/disable").at(-1)?.body).toEqual({
      password: "sandi-benar-123",
      backupCode: "abcde-fghjk",
    });
    expect(await screen.findByText("Belum aktif")).toBeInTheDocument();
  });
});

describe("Perangkat yang masuk (L41b)", () => {
  const here = {
    id: "AAAAAAAAAAAAAAAAAAAAAA",
    current: true,
    createdAt: "2026-10-07T01:00:00.000Z",
    lastSeenAt: "2026-10-07T01:00:00.000Z",
    ip: "10.1.2.3",
    browser: "Chrome",
    os: "macOS",
  };
  const phone = { ...here, id: "BBBBBBBBBBBBBBBBBBBBBB", current: false, ip: "10.9.9.9", browser: "Safari", os: "iOS" };
  const laptop = { ...here, id: "CCCCCCCCCCCCCCCCCCCCCC", current: false, ip: null, browser: null, os: null };

  it("lists this device first, then signs one other device out, then all the rest after asking", async () => {
    let items = [here, phone, laptop];
    const calls = mockApi({
      "GET /v1/me/sessions": () => ({ items, next_cursor: null }),
      [`DELETE /v1/me/sessions/${phone.id}`]: () => {
        items = items.filter((s) => s.id !== phone.id);
        return undefined;
      },
      "POST /v1/me/sessions/revoke-others": () => {
        items = [here];
        return { revoked: 1 };
      },
    });
    const user = userEvent.setup();
    renderApp(<SessionsCard />);
    const list = await screen.findByRole("list", { name: "Perangkat yang masuk" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Chrome di macOS");
    expect(rows[0]).toHaveTextContent("Perangkat ini");
    expect(rows[0]).toHaveTextContent("IP 10.1.2.3");
    expect(within(rows[0]!).queryByRole("button")).not.toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("Safari di iOS");
    expect(rows[2]).toHaveTextContent("Perangkat tidak dikenal");
    expect(rows[2]).toHaveTextContent("IP —");

    await user.click(screen.getByRole("button", { name: "Keluarkan Safari di iOS" }));
    expect(await screen.findByText("Safari di iOS dikeluarkan.")).toBeInTheDocument();
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: "Keluar dari semua perangkat lain" }));
    const ask = await screen.findByRole("dialog", { name: "Keluar dari semua perangkat lain?" });
    await user.click(within(ask).getByRole("button", { name: "Keluar dari semua perangkat lain" }));
    expect(await screen.findByText("1 perangkat dikeluarkan.")).toBeInTheDocument();
    expect(await screen.findByText("Tidak ada perangkat lain yang sedang masuk.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual([
      `DELETE /v1/me/sessions/${phone.id}`,
      "POST /v1/me/sessions/revoke-others",
    ]);
  });
});
