import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Wheel",
  description: "Treasury Wheel web dashboard"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
