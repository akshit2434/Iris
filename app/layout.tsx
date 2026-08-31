import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist } from "next/font/google";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/service-worker-register";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

export const metadata: Metadata = {
  title: "Iris",
  description: "A private personal agent for the things that matter now.",
  applicationName: "Iris",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/iris-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/iris-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/iris-192.png", sizes: "192x192", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "Iris",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#f4f6fb",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className={geist.variable}>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
