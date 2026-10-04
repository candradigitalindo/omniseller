"use client";

/**
 * The root layout itself failed: no messages, fonts, or styles are loaded here, so the page carries its
 * own Indonesian text and plain inline styles (Next renders it instead of the root layout).
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="id">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#F4F6F8", color: "#1B2430" }}>
        <title>OmniSeller</title>
        <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16, textAlign: "center" }}>
          <div style={{ maxWidth: 420 }}>
            <h1 style={{ fontSize: 22 }}>OmniSeller tidak bisa dimuat</h1>
            <p style={{ color: "#6B7683" }}>
              Coba lagi sebentar lagi. Bila masih gagal, hubungi kami dengan kode di bawah.
            </p>
            {error.digest ? (
              <p style={{ fontFamily: "monospace", fontSize: 13, color: "#6B7683" }}>{error.digest}</p>
            ) : null}
            <button
              type="button"
              onClick={() => retry()}
              style={{
                height: 40,
                padding: "0 16px",
                borderRadius: 8,
                border: 0,
                background: "#1E6B8C",
                color: "#fff",
                fontSize: 15,
              }}
            >
              Coba lagi
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
