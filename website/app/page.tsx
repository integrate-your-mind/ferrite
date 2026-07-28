import { siteUrl } from "./metadata";

const repositoryUrl = "https://github.com/integrate-your-mind/ferrite";
const demoSha = "8716f30c83b9e4fc0835c2f37f9c00bd26e8152d";
const featureRows = [
  ["Available", "Compiler-owned module graph", "Rust owns edges, cycle diagnostics, and invalidation."],
  ["Available", "Rust SSR and filesystem routing", "Layouts, metadata, escaping, and artifact-backed serving."],
  ["Available", "TypeScript client islands", "TSX, hydration, hooks, navigation, and serializable boundaries."],
  ["Partial", "Server actions", "CSRF, replay, proxy, audit, and public-error controls exist; auth is incomplete."],
  ["Experimental", "Deployment adapter", "This site packages Ferrite output for Sites; the adapter is not Ferrite itself."],
  ["Planned", "Public distribution", "Registry packages, CLI acquisition, and broad clean-machine onboarding."],
] as const;
export const metadata = { title: "Ferrite — Rust-first application framework", description: "Explore a source-backed Ferrite application built with the @ferrite/runtime app-directory contract.", alternates: { canonical: siteUrl("/") } };
function Status({ value }: { value: string }) { return <span className={`status ${value.toLowerCase()}`}>{value}</span>; }
export default function HomePage() {
  return <>
    <section className="hero"><div className="wrap hero-grid"><div>
      <p className="eyebrow">Open source · source-build preview</p><h1>Ferrite<span>.</span></h1>
      <p className="hero-lede">Rust owns the control plane. TypeScript stays on top.</p>
      <p>Ferrite is an experimental app runtime for teams who want an explicit route graph, deterministic artifacts, and a small, readable client boundary.</p>
      <div className="actions"><a className="button primary" href="/examples">Run the interactive examples</a><a className="button" href="/docs/getting-started">Read getting started</a></div>
      <p className="hero-note">Developer preview. No drop-in React claim, no managed production endpoint, no invented benchmark.</p>
    </div><aside className="proof-box"><p className="eyebrow">Evidence receipt</p><strong>8716f30</strong><p>Docs Workbench capture head</p><code>examples/docs-workbench</code><p className="hero-note">Local screenshots are tied to this exact source revision. They are not hosted proof.</p></aside></div></section>
    <section className="section"><div className="wrap"><p className="kicker">01 / The thesis</p><div className="section-heading"><h2>Make the build and runtime contract visible.</h2><p className="lede">Ferrite explores one explicit path from TSX source to a verified artifact, without hiding the boundaries where a feature is partial or still planned.</p></div><div className="grid-3"><article><h3>Control</h3><p>Compiler-owned graph carries source ownership through build and serve.</p></article><article><h3>Fast failure</h3><p>Cycles, stale artifacts, path escapes, and ambiguous requests fail at a named boundary.</p></article><article><h3>Honest proof</h3><p>Local runtime evidence stays separate from CI, registry, cross-platform, and production claims.</p></article></div></div></section>
    <section className="section"><div className="wrap"><p className="kicker">02 / Source-backed captures</p><h2>Real routes, pinned to a real head.</h2><p className="lede">These images came from the source-built Docs Workbench example. The gallery is evidence of that capture, not a live Ferrite endpoint.</p><div className="evidence"><figure><img src="/demos/docs-guide-desktop.png" alt="Ferrite Docs Workbench architecture guide route on desktop"/><figcaption><b>/guides/architecture</b> · generated guide route</figcaption></figure><figure><img src="/demos/docs-catchall-desktop.png" alt="Ferrite Docs Workbench unlisted catch-all route showing unavailable content"/><figcaption><b>/guides/unlisted/path</b> · explicit unavailable state</figcaption></figure></div><p className="demo-status">Capture head <code>{demoSha}</code> · local evidence only · <a href="/blog/tic-tac-toe">Read the interactive walkthrough →</a></p></div></section>
    <section className="section"><div className="wrap"><p className="kicker">03 / Capability ledger</p><h2>What is true today?</h2><div className="grid-3">{featureRows.map(([status, title, detail]) => <article key={title}><Status value={status}/><h3>{title}</h3><p>{detail}</p></article>)}</div></div></section>
    <section className="section"><div className="wrap"><p className="kicker">04 / Architecture</p><div className="dark-panel"><h2>Source → compiler → artifact → serve</h2><p>Ferrite compiles and SSRs this application through the <code>@ferrite/runtime</code> app-directory contract. A plain Worker adapter only serves immutable output for Sites; it does not replace the Ferrite compiler or runtime.</p><pre>{`app/page.tsx       →   ferrite-cli check/build\napp/layout.tsx     →   SSR + metadata + document\n"use client"       →   browser island bundle\n.ferrite/build     →   artifact-only serve`}</pre></div></div></section>
    <section className="section"><div className="wrap"><p className="kicker">05 / Next steps</p><h2>See it, then interrogate the limits.</h2><div className="actions"><a className="button primary" href="/docs">Browse the docs</a><a className="button" href="/compare">Compare with React and Next</a><a className="button" href={repositoryUrl}>Inspect source ↗</a></div><div className="notice warning"><b>Important boundary.</b> Ferrite is not a drop-in React or Next.js replacement. Read the migration matrix and incompatibilities before evaluating a move.</div></div></section>
  </>;
}
