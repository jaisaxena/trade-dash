import type { Metadata } from "next";
import AppHeader from "@/components/AppHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trade Dash",
  description: "Trading dashboard",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  ),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AppHeader />
        {children}
      </body>
    </html>
  );
}
