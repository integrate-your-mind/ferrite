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
  const demos: Array<{ label: string; path: string }> = [
    { label: "2-D Tic Tac Toe", path: "/tic-tac-toe" },
    { label: "3-D Tic Tac Toe (Three.js)", path: "/tic-tac-toe-3d" },
    { label: "Error demo", path: "/error-demo" },
    { label: "Route loading", path: "/route-loading" },
  ];

  return (
    <main className="home-shell" data-route={home}>
      <h1>Ferrite Home</h1>
      <button type="button" onClick={() => setCount(count + 1)}>
        Count: {count}
      </button>
      <p className="home-demo-intro">Try a live demo:</p>
      <ul className="home-demos-list">
        {demos.map((demo) => (
          <li key={demo.path}>
            <a href={demo.path}>{demo.label}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}
