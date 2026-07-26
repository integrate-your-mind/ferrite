import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const title = "Ferrite — Rust-first application framework";
const description =
  "Ferrite is a Rust-first framework experiment with a JavaScript and TypeScript developer surface, deterministic builds, and artifact-backed serving.";

const defaultSiteOrigin = "http://localhost:3000";

function getSiteOrigin(): URL {
  const configuredOrigin = process.env.FERRITE_SITE_ORIGIN?.trim();
  if (!configuredOrigin) {
    return new URL(defaultSiteOrigin);
  }

  if (!/^https?:\/\/[^/?#\\]+\/?$/i.test(configuredOrigin)) {
    throw new Error("FERRITE_SITE_ORIGIN must be an HTTP or HTTPS origin without credentials, a path, query, or fragment");
  }

  let origin: URL;
  try {
    origin = new URL(configuredOrigin);
  } catch {
    throw new Error("FERRITE_SITE_ORIGIN must be an absolute HTTP or HTTPS origin");
  }

  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("FERRITE_SITE_ORIGIN must be an HTTP or HTTPS origin without credentials, a path, query, or fragment");
  }

  return new URL(origin.origin);
}

export function generateMetadata(): Metadata {
  const metadataBase = getSiteOrigin();
  const socialImage = new URL("/og.png", metadataBase).toString();

  return {
    metadataBase,
    title,
    description,
    alternates: {
      canonical: "/",
    },
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title,
      description: "Rust owns the control plane. TypeScript stays on top.",
      type: "website",
      images: [
        {
          url: socialImage,
          width: 1731,
          height: 909,
          alt: "Ferrite: Rust owns the control plane. TypeScript stays on top.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: "Rust owns the control plane. TypeScript stays on top.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
