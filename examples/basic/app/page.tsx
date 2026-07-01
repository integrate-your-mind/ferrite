"use client";

import { useState } from "@ferrite/runtime";
import "./page.css";

export const metadata = {
  title: "Ferrite Home",
  description: "Interactive Ferrite home route.",
  openGraph: {
    title: "Ferrite Home",
    description: "Interactive Ferrite home route.",
    url: "https://example.com/",
    images: [{ url: "/og-home.png", alt: "Ferrite home", width: 1200, height: 630 }],
  },
  alternates: {
    canonical: "https://example.com/",
  },
};

export default function Page() {
  const [count, setCount] = useState(0);
  const home: Ferrite.RoutePath = "/";

  return (
    <main className="home-shell" data-route={home}>
      <h1>Ferrite Home</h1>
      <button type="button" onClick={() => setCount(count + 1)}>
        Count: {count}
      </button>
    </main>
  );
}
