import type { Child } from "@ferrite/runtime";
import SiteChrome from "./components/SiteChrome";
import { getSiteOrigin, siteUrl } from "./metadata";

const siteOrigin = getSiteOrigin();

export const metadata = {
  title: "Ferrite — Rust-first application framework",
  description: "A source-backed developer preview of Ferrite, a Rust-first application framework with a TypeScript surface.",
  openGraph: { siteName: "Ferrite", type: "website", url: siteOrigin + "/", images: [{ url: siteUrl("/og.png"), alt: "Ferrite developer preview", width: 1731, height: 909 }] },
  alternates: { canonical: siteOrigin + "/" },
  twitter: { card: "summary_large_image", title: "Ferrite — Rust-first application framework", description: "A source-backed Ferrite developer preview.", images: [siteUrl("/og.png")] },
  icons: [{ url: "/favicon.svg", type: "image/svg+xml", sizes: "any" }],
};

export default function RootLayout({ children }: { children: Child }) {
  return <SiteChrome>{children}</SiteChrome>;
}
