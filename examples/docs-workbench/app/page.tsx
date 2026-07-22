export const metadata = {
  title: "Ferrite Docs Workbench · Server-first docs, made observable",
  description: "A real Ferrite example showing static guides, dynamic reference pages, metadata, and one small client island.",
};

const signals = [
  { label: "Route graph", value: "compiler-owned" },
  { label: "Rendering", value: "server-first" },
  { label: "Hydration", value: "isolated island" },
];

export default function HomePage() {
  return (
    <div className="page-frame">
      <section className="hero-grid" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow"><span className="signal-dot" aria-hidden="true" /> Ferrite example / 01</p>
          <h1 id="hero-title">Documentation that<br /><em>stays close to the graph.</em></h1>
          <p className="hero-lede">Docs Workbench is a small, real Ferrite app for framework evaluators. It keeps content server-first while making the route graph, metadata, and client boundary easy to inspect.</p>
          <div className="hero-actions">
            <a className="button button-primary" href="/guides/getting-started">Read the guide <span aria-hidden="true">→</span></a>
            <a className="button button-secondary" href="/reference/runtime">Open reference</a>
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="graph-label graph-label-top">APP /</div>
          <div className="graph-node graph-node-root"><span>server</span><strong>route</strong></div>
          <div className="graph-line graph-line-one" />
          <div className="graph-node graph-node-static"><span>static</span><strong>guides</strong></div>
          <div className="graph-line graph-line-two" />
          <div className="graph-node graph-node-dynamic"><span>dynamic</span><strong>reference</strong></div>
          <div className="graph-chip">use client</div>
          <div className="graph-footnote">one hydrated island / no full-route bundle</div>
        </div>
      </section>

      <section className="signal-strip" aria-label="Example characteristics">
        {signals.map((signal) => <div className="signal-item" key={signal.label}><span>{signal.label}</span><strong>{signal.value}</strong></div>)}
      </section>

      <section className="intro-section content-grid" aria-labelledby="why-title">
        <div><p className="section-index">01 / Why this exists</p><h2 id="why-title">Make the framework’s shape part of the product.</h2></div>
        <div className="prose"><p>Framework demos often flatten into a single page and a single claim. This workbench stays deliberately small: a home route, a static catch-all guide, a dynamic reference page, a custom document, and one interactive chrome island.</p><p>That gives evaluators a useful boundary to inspect in source and in output. The page is server-rendered by default. Only the navigation affordance needs browser state.</p></div>
      </section>

      <section className="cards-section" aria-labelledby="surface-title">
        <div className="section-heading"><p className="section-index">02 / Surface map</p><h2 id="surface-title">Three things to look for.</h2></div>
        <div className="surface-cards">
          <article className="surface-card"><span className="card-number">A</span><h3>Static guides</h3><p><code>/guides/*slug</code> uses <code>generateStaticParams</code> for known pages, while the same component handles catch-all path data.</p><a href="/guides/getting-started">Inspect guides <span aria-hidden="true">↗</span></a></article>
          <article className="surface-card surface-card-accent"><span className="card-number">B</span><h3>Dynamic reference</h3><p><code>/reference/:id</code> derives its title and description from route params through <code>generateMetadata</code>.</p><a href="/reference/runtime">Inspect reference <span aria-hidden="true">↗</span></a></article>
          <article className="surface-card"><span className="card-number">C</span><h3>One client island</h3><p>The menu button owns a tiny <code>useState</code> boundary. The surrounding docs content remains server-first.</p><a href="/guides/architecture">Read architecture <span aria-hidden="true">↗</span></a></article>
        </div>
      </section>

      <section className="terminal-panel" aria-labelledby="terminal-title">
        <div><p className="section-index">03 / Source checkout</p><h2 id="terminal-title">Run the boundary yourself.</h2></div>
        <div className="terminal"><div className="terminal-bar"><span /><span /><span /><b>source checkout commands</b></div><pre><code><span className="terminal-muted">$</span> pnpm install
<span className="terminal-muted">$</span> cargo run -p ferrite-cli -- check --project examples/docs-workbench
<span className="terminal-muted">$</span> cargo run -p ferrite-cli -- dev --project examples/docs-workbench</code></pre></div>
      </section>
    </div>
  );
}
