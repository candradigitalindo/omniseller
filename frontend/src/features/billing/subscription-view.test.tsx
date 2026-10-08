import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { type ApiCall, mockApi, problem, renderApp, testMe } from "@/test/render";
import type { BillingState } from "./billing-meta";
import { ACTIVE, GROWTH, invoice, ON_BUSINESS, TRIAL } from "./fixtures";
import { SubscriptionView } from "./subscription-view";

const posts = (calls: ApiCall[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);
const chosen = (calls: ApiCall[]) => posts(calls, "/v1/billing/subscription").map((c) => c.body);

describe("Langganan & Tagihan", () => {
  it("shows the trial, its quotas as bars, and what each plan would do", async () => {
    mockApi({ "GET /v1/billing/subscription": () => TRIAL });
    renderApp(<SubscriptionView />);
    const current = await screen.findByTestId("current-plan");
    expect(within(current).getByText("Paket Growth")).toBeInTheDocument();
    expect(within(current).getByText("Uji coba")).toBeInTheDocument();
    expect(within(current).getByText("Rp 899.000 per bulan")).toBeInTheDocument();
    expect(within(current).getByText(/Uji coba gratis berakhir 15 Okt 2026/)).toBeInTheDocument();
    // usage against the quotas
    expect(screen.getByText("3.200 dari 10.000")).toBeInTheDocument();
    expect(screen.getByText("1 dari 2")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(4);
    expect(screen.getByRole("progressbar", { name: "Pesanan bulan ini: 3.200 dari 10.000" })).toBeInTheDocument();
    // the plans: pay for Growth after the trial, go up now, or down to the free plan
    expect(screen.getByRole("button", { name: "Berlangganan Growth" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Naik ke Business" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Turun ke Starter" })).toBeEnabled();
    expect(screen.getByText("Toko marketplace tidak dibatasi")).toBeInTheDocument();
    expect(screen.getAllByText("Fitur inti + 7 fitur lanjutan")).toHaveLength(2);
    expect(screen.getByText("Belum ada tagihan.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Ubah di Profil bisnis" })).not.toBeInTheDocument();
  });

  it("asks for an invoice when a pricier plan is chosen, links to its payment page, and lets it be withdrawn", async () => {
    const pending = invoice();
    let state: BillingState = TRIAL;
    const calls = mockApi({
      "GET /v1/billing/subscription": () => state,
      "POST /v1/billing/subscription": () => {
        state = { ...TRIAL, pendingInvoice: pending, invoices: [pending] };
        return state;
      },
      [`POST /v1/billing/invoices/${pending.id}/void`]: () => {
        state = { ...TRIAL, invoices: [{ ...pending, status: "void" }] };
        return { ...pending, status: "void" };
      },
    });
    const user = userEvent.setup();
    renderApp(<SubscriptionView />);
    await user.click(await screen.findByRole("button", { name: "Naik ke Business" }));
    await waitFor(() => expect(chosen(calls)).toEqual([{ planCode: "business" }]));
    expect(
      await screen.findByText("Tagihan dibuat. Bayar lewat halaman pembayaran; paket aktif begitu dibayar."),
    ).toBeInTheDocument();
    // the invoice to pay, above the plans, with Xendit's page and a way out
    const callout = screen.getByRole("status", { name: "Tagihan menunggu dibayar" });
    expect(callout).toHaveTextContent(
      "INV-2610-0001 untuk paket Business, Rp 2.499.000. Bayar sebelum 8 Okt 2026; paket aktif begitu dibayar.",
    );
    expect(within(callout).getByRole("link", { name: "Bayar INV-2610-0001" })).toHaveAttribute(
      "href",
      "https://checkout.xendit.co/web/abc123",
    );
    // the Business card points at the payment page too
    expect(screen.queryByRole("button", { name: "Naik ke Business" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Bayar INV-2610-0001" })).toHaveLength(2);
    await user.click(within(callout).getByRole("button", { name: "Batalkan tagihan INV-2610-0001" }));
    await waitFor(() => expect(posts(calls, `/v1/billing/invoices/${pending.id}/void`)).toHaveLength(1));
    expect(await screen.findByText("Tagihan dibatalkan.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Naik ke Business" })).toBeEnabled());
    expect(within(screen.getByRole("table", { name: "Riwayat tagihan" })).getByText("Dibatalkan")).toBeInTheDocument();
  });

  it("shows what is taken off a move up from a paid month, and waits for its payment page", async () => {
    mockApi({
      "GET /v1/billing/subscription": () => ({
        ...ACTIVE,
        pendingInvoice: invoice({ amount: 1_899_667, creditAmount: 599_333, invoiceUrl: null }),
      }),
    });
    renderApp(<SubscriptionView />);
    const callout = await screen.findByRole("status", { name: "Tagihan menunggu dibayar" });
    expect(callout).toHaveTextContent("INV-2610-0001 untuk paket Business, Rp 1.899.667.");
    expect(callout).toHaveTextContent("Sudah dipotong sisa periode yang dibayar, Rp 599.333.");
    expect(within(callout).getByText("Halaman pembayaran sedang disiapkan…")).toBeInTheDocument();
    // the plan card says the same in a few words, and cannot be pressed meanwhile
    expect(screen.getByRole("button", { name: "Menyiapkan pembayaran…" })).toBeDisabled();
  });

  it("keeps a paid plan's renewal, and confirms a step down to Starter for the end of the paid month", async () => {
    const calls = mockApi({
      "GET /v1/billing/subscription": () => ACTIVE,
      "POST /v1/billing/subscription": () => ({ ...ACTIVE, nextPlan: TRIAL.plans[0], pendingInvoice: null }),
    });
    const user = userEvent.setup();
    renderApp(<SubscriptionView />);
    expect(await screen.findByText(/Periode berjalan sampai 12 Okt 2026/)).toBeInTheDocument();
    const callout = screen.getByRole("status", { name: "Tagihan menunggu dibayar" });
    expect(callout).toHaveTextContent(
      "INV-2610-0002 untuk paket Growth, 12 Okt 2026 sampai 12 Nov 2026, Rp 899.000. Jatuh tempo 12 Okt 2026.",
    );
    // the renewal can be paid but not withdrawn by hand
    expect(within(callout).getByRole("link", { name: "Bayar INV-2610-0002" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Batalkan tagihan/ })).not.toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Riwayat tagihan" });
    expect(within(table).getByText("Dibayar 12 Sep 2026 lewat transfer bank BCA")).toBeInTheDocument();
    expect(within(table).getAllByText("Perpanjangan")).toHaveLength(2);
    // the phone list carries the same
    const phoneList = screen.getByRole("list", { name: "Riwayat tagihan" });
    expect(within(phoneList).getAllByRole("listitem")).toHaveLength(2);
    // every invoice as PDF, with the business's NPWP from its profile
    const pdfs = within(table).getAllByRole("link", { name: /^Unduh PDF tagihan / });
    expect(pdfs.map((a) => a.getAttribute("href"))).toEqual([
      "/v1/billing/invoices/01JINV00000000000000000002/pdf",
      "/v1/billing/invoices/01JINV00000000000000000001/pdf",
    ]);
    expect(within(table).getByRole("link", { name: "Unduh PDF tagihan INV-2609-0001" })).toHaveAttribute("download");
    expect(within(phoneList).getAllByRole("link", { name: /^Unduh PDF tagihan / })).toHaveLength(2);
    expect(screen.getByText(/PDF tagihan memuat nama, alamat, dan NPWP bisnis/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ubah di Profil bisnis" })).toHaveAttribute("href", "/profil-bisnis");

    await user.click(screen.getByRole("button", { name: "Turun ke Starter" }));
    const dialog = screen.getByRole("dialog", { name: "Turun ke Starter?" });
    expect(dialog).toHaveTextContent("Paket Growth tetap aktif sampai 12 Okt 2026.");
    expect(dialog).toHaveTextContent("2 toko marketplace, 1 gudang, 1.000 pesanan per bulan, 2 pengguna");
    await user.click(within(dialog).getByRole("button", { name: "Ya, turun ke Starter" }));
    await waitFor(() => expect(chosen(calls)).toEqual([{ planCode: "starter" }]));
    expect(await screen.findByText("Paket Starter berlaku mulai 12 Okt 2026.")).toBeInTheDocument();
    expect(screen.getByText("Paket berakhir 12 Okt 2026, lalu bisnis memakai Starter.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Berlaku 12 Okt 2026" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tetap di Growth" })).toBeEnabled();
  });

  it("moves from Business to Growth at the end of the paid month, with Growth's price spelled out", async () => {
    const calls = mockApi({
      "GET /v1/billing/subscription": () => ON_BUSINESS,
      "POST /v1/billing/subscription": () => ({ ...ON_BUSINESS, nextPlan: GROWTH }),
    });
    const user = userEvent.setup();
    renderApp(<SubscriptionView />);
    // Growth is cheaper than Business: never "Naik ke Growth"
    await user.click(await screen.findByRole("button", { name: "Pindah ke Growth" }));
    const dialog = screen.getByRole("dialog", { name: "Pindah ke Growth?" });
    expect(dialog).toHaveTextContent(
      "Paket Business tetap aktif sampai 12 Okt 2026. Mulai saat itu bisnis memakai Growth, Rp 899.000 per bulan; tagihannya dibuat 7 hari sebelumnya.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Ya, pindah ke Growth" }));
    await waitFor(() => expect(chosen(calls)).toEqual([{ planCode: "growth" }]));
    expect(await screen.findByText("Paket Growth berlaku mulai 12 Okt 2026.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tetap di Business" })).toBeEnabled();
  });

  it("locks other plans once the next period is paid, and says until when", async () => {
    const prepaid = invoice({
      kind: "renewal",
      planCode: "growth",
      planName: "Growth",
      status: "paid",
      periodStart: "2026-10-12T04:00:00.000Z",
      periodEnd: "2026-11-12T04:00:00.000Z",
      paidAt: "2026-10-08T02:00:00.000Z",
    });
    mockApi({
      "GET /v1/billing/subscription": () => ({ ...ON_BUSINESS, nextPlan: GROWTH, prepaidInvoice: prepaid }),
    });
    renderApp(<SubscriptionView />);
    expect(
      await screen.findByText("Periode berikutnya sudah dibayar: paket Growth, 12 Okt 2026 sampai 12 Nov 2026."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Berlaku 12 Okt 2026" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pilih Starter" })).toBeDisabled();
    expect(
      screen.getByText("Periode berikutnya sudah dibayar; paket bisa diubah lagi mulai 12 Okt 2026."),
    ).toBeInTheDocument();
  });

  it("keeps paid plans out of reach where payments are not set up, and shows the api's refusal", async () => {
    mockApi({
      "GET /v1/billing/subscription": () => ({ ...TRIAL, paymentsAvailable: false }),
      "POST /v1/billing/subscription": () =>
        problem(
          422,
          "billing.limit_reached",
          "Paket Starter membatasi 1 gudang. Naik paket di Langganan & Tagihan untuk menambah.",
        ),
    });
    const user = userEvent.setup();
    renderApp(<SubscriptionView />);
    expect(await screen.findByRole("button", { name: "Naik ke Business" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Berlangganan Growth" })).toBeDisabled();
    expect(screen.getAllByText("Pembayaran belum tersedia di lingkungan ini.")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Turun ke Starter" }));
    const dialog = screen.getByRole("dialog", { name: "Turun ke Starter sekarang?" });
    expect(dialog).toHaveTextContent("Uji coba berhenti sekarang.");
    await user.click(within(dialog).getByRole("button", { name: "Ya, turun ke Starter" }));
    expect(await screen.findByText(/Paket Starter membatasi 1 gudang/)).toBeInTheDocument();
  });

  it("welcomes the seller back from the payment page and cleans the address", async () => {
    mockApi({ "GET /v1/billing/subscription": () => TRIAL });
    setUrl("/langganan?bayar=sukses");
    renderApp(<SubscriptionView />);
    expect(await screen.findByText(/Terima kasih\. Paket aktif begitu Xendit mengonfirmasi/)).toBeInTheDocument();
    await waitFor(() => expect(currentUrl()).toBe("/langganan"));
  });

  it("is the business keeper's page: others see only why", async () => {
    const calls = mockApi({ "GET /v1/billing/subscription": () => TRIAL });
    renderApp(<SubscriptionView />, { me: testMe(["order:read"]) });
    expect(screen.getByText("Hanya pemilik bisnis yang mengelola langganan dan tagihan.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
