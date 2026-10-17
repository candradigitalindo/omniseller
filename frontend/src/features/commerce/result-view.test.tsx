import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";
import { CommerceResultView } from "./result-view";

describe("commerce readable results", () => {
  it("shows Indonesian money and times while withholding credential keys", () => {
    renderApp(
      <CommerceResultView
        value={{
          total: { amount: "125000", currency: "IDR" },
          created_at: "2026-10-17T01:00:00Z",
          accessToken: "access-private",
          category_asset_cipher: "cipher-private",
          name: "Produk Candra",
        }}
      />,
    );
    expect(screen.getByText("Rp 125.000")).toBeInTheDocument();
    expect(screen.getByText("17 Okt 2026, 08.00")).toBeInTheDocument();
    expect(screen.getByText("Produk Candra")).toBeInTheDocument();
    expect(screen.queryByText("access-private")).not.toBeInTheDocument();
    expect(screen.queryByText("cipher-private")).not.toBeInTheDocument();
  });
});
