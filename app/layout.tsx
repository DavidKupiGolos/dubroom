import type { Metadata } from "next";
import "./globals.css";

const siteUrl = new URL("https://dubroom.186-246-46-242.sslip.io");
const title = "DUBROOM | студия озвучки";
const description = "Записывайте реплики, получайте оценку дубля и собирайте готовое видео прямо в браузере.";

export const metadata: Metadata = {
  metadataBase: siteUrl,
  referrer: "no-referrer",
  title,
  description,
  openGraph: {
    title,
    description,
    type: "website",
    images: [{ url: "/og.png", width: 1680, height: 945, alt: "DUBROOM, студия озвучки" }],
  },
  twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700;900&subset=cyrillic&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
