import type { Metadata } from "next";
import { Be_Vietnam_Pro, Geist_Mono } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import Script from "next/script";

import { NotifyProvider } from "@/components/ui/notify-provider";
import { ThemeProvider } from "@/lib/theme/theme-provider";
import { buildThemeInitScript } from "@/lib/theme/theme-registry";
import "./globals.css";

const geistSans = Be_Vietnam_Pro({
  variable: "--font-geist-sans",
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "600", "700", "800"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Hệ thống báo cáo HRP",
  description: "Sales Performance & Reporting System V1",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="vi"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <Script id="theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: buildThemeInitScript() }} />
        <ThemeProvider>
          <NotifyProvider>
            <NuqsAdapter>{children}</NuqsAdapter>
          </NotifyProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
