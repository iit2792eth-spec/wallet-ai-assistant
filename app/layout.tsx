import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppSidebar } from "@/components/app-sidebar";
import { SessionProvider } from "@/components/session-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { TopBar } from "@/components/top-bar";
import { themeBootScript } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Wallet Access Layer",
  description:
    "A permissioned access layer between an AI agent and an Ethereum wallet.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className="flex h-full">
        <ThemeProvider>
          <SessionProvider>
            <AppSidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <TopBar />
              <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
            </div>
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
