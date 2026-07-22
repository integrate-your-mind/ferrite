import Link from "next/link";

export const metadata = {
  title: "Ferrite Blog",
  description: "Proof-oriented Ferrite updates and examples.",
  alternates: {
    canonical: "/blog",
  },
};

export default function BlogIndexPage() {
  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "120px 22px 80px" }}>
      <div className="kicker">Blog</div>
      <h1 style={{ marginTop: "0.4rem", marginBottom: "1.1rem", maxWidth: 760 }}>Ferrite building notes</h1>
      <p style={{ color: "#4b5563", maxWidth: 780 }}>
        Short-form walkthroughs for people evaluating Ferrite as a React-style app runtime.
      </p>
      <ul style={{ marginTop: "1.4rem", paddingLeft: "1.1rem" }}>
        <li>
          <Link href="/blog/tic-tac-toe" style={{ textDecoration: "underline" }}>
            Build a complete Tic Tac Toe app in Ferrite (interactive) →
          </Link>
        </li>
        <li>
          <Link href="/blog/tic-tac-toe-3d" style={{ textDecoration: "underline" }}>
            Build a 3-D Tic Tac Toe app in Ferrite with Three.js →
          </Link>
        </li>
      </ul>
    </main>
  );
}
