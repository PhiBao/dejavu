import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { PwaRegister } from "@/components/PwaRegister";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Dejavu — a memory companion",
  description:
    "A memory companion for everything worth remembering — people, notes, promises — with portable, verifiable memory on Walrus.",
  manifest: "/manifest.webmanifest",
  applicationName: "Dejavu",
  appleWebApp: {
    capable: true,
    title: "Dejavu",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f1115",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
