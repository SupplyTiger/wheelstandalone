import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Wheel — CSP Screener",
  description: "Institutional Treasury Wheel CSP screener",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
