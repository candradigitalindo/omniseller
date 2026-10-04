import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { Providers } from "@/components/providers";
import "./globals.css";

/** Typography of DOKUMEN-UI-UX 5: Inter for text and numbers, Plus Jakarta Sans for headings, JetBrains Mono for SKUs and tracking numbers. */
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const jakarta = Plus_Jakarta_Sans({ variable: "--font-jakarta", subsets: ["latin"], display: "swap" });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "OmniSeller", template: "%s · OmniSeller" },
  description: "Kelola pesanan, stok, dan toko Shopee serta Tokopedia & Shop dari satu tempat.",
};

export const viewport: Viewport = {
  themeColor: "#f4f6f8",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="id"
      className={`${inter.variable} ${jakarta.variable} ${jetbrains.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full">
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
