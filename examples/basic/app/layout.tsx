import type { Child } from "@ferrite/runtime";

export const metadata = {
  title: "Ferrite Example",
  description: "A Rust-first Ferrite example app.",
  openGraph: {
    siteName: "Ferrite Example",
    type: "website",
  },
  icons: [{ url: "/favicon.svg", type: "image/svg+xml", sizes: "any" }],
  alternates: {
    languages: {
      en: "https://example.com/",
    },
  },
};

export default function RootLayout({ children }: { children: Child }) {
  return <section data-layout="root">{children}</section>;
}
