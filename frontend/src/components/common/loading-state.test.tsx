import { useQuery } from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render";
import { FormBanner } from "./form";
import { RequestActivity } from "./loading-state";

describe("request feedback", () => {
  afterEach(() => vi.useRealTimers());
  it("waits before announcing a request, explains long waits, and disappears when finished", async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    function Screen() {
      useQuery({ queryKey: ["feedback-test"], queryFn: () => pending });
      return <RequestActivity />;
    }
    renderApp(<Screen />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Memuat data terbaru");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7550);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Koneksi sedang membutuhkan waktu lebih lama.");
    await act(async () => {
      finish("done");
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("gives form errors an accessible dismissal action", () => {
    const dismiss = vi.fn();
    renderApp(<FormBanner message="Periksa kata sandi Anda." onDismiss={dismiss} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Periksa kata sandi Anda.");
    fireEvent.click(screen.getByRole("button", { name: "Tutup pemberitahuan" }));
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
