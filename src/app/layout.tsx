import type { Metadata } from "next";
import AppHeader from "@/components/AppHeader";
import Providers from "@/components/Providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trade Dash",
  description: "Options trading pipeline",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppHeader />
          {children}
        </Providers>
      </body>
    </html>
  );
}
