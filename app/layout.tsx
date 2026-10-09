import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Wheel — Investing Dashboard",
  description: "Institutional Treasury Wheel dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
