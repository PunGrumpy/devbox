import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import type { PropsWithChildren } from "react";

const sans = Geist({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-geist-sans",
  weight: "variable",
});

export const viewport: Viewport = {
  colorScheme: "light dark",
  initialScale: 1,
  themeColor: [
    { color: "#f5f5f4", media: "(prefers-color-scheme: light)" },
    { color: "#10120f", media: "(prefers-color-scheme: dark)" },
  ],
  width: "device-width",
};

export const metadata: Metadata = {
  description: "Every machine, where it is, and whether it runs T3 Code.",
  robots: { follow: false, index: false },
  title: "devbox hub",
};

const RootLayout = ({ children }: PropsWithChildren) => (
  <html className={sans.variable} lang="en">
    <body>{children}</body>
  </html>
);

export default RootLayout;
