import type { Metadata, Viewport } from "next";
import { LOYALTY_PROGRAMME_NAME } from "@padelloyalty/shared";
import "./globals.css";

export const metadata: Metadata = {
  title: "Soul Padel",
  description: `Soul Padel bookings and ${LOYALTY_PROGRAMME_NAME}`,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets the layout extend under notches; padding uses safe-area insets.
  viewportFit: "cover",
  themeColor: "#0f3d3e",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
