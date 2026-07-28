import DocsNav from "../../components/DocsNav";
import { siteUrl } from "../../metadata";

export const metadata = { title: "Architecture · Ferrite", description: "Ferrite source-to-artifact architecture.", alternates: { canonical: siteUrl("/docs/architecture") } };

export default function Architecture() {
  return <div className="wrap article">
    <p className="kicker">Docs / Architecture</p>
    <h1>One graph, three rendering modes.</h1>
    <p>Ferrite keeps route discovery, dependency edges, page rendering, browser bundles, and artifact serving explicit. Rust is the control plane; TypeScript remains the authoring surface.</p>
    <DocsNav/>
    <div className="dark-panel"><pre>{"TSX app directory\n       │\n       ▼\nNode page runner ─── client import guard\n       │\n       ▼\nRust route graph + SSR + protocol validation\n       │\n       ▼\n.ferrite/build (manifest, server output, prerenders, immutable assets)\n       │\n       ├── request-time server rendering\n       ├── browser mounting and hydration\n       └── prerendered static delivery"}</pre></div>
    <h2>Rendering modes</h2>
    <table className="table">
      <caption>Rendering contracts available in the developer preview</caption>
      <thead><tr><th>Mode</th><th>Status</th><th>Boundary</th></tr></thead>
      <tbody>
        <tr><td>Server-side rendering</td><td><span className="status available">Available</span></td><td>The artifact server renders matched routes at request time, including layouts, metadata, errors, and streaming responses.</td></tr>
        <tr><td>Client-side rendering</td><td><span className="status available">Available</span></td><td>The browser DOM runtime mounts or hydrates typed TSX, hooks, events, state, effects, and explicit client-reference islands.</td></tr>
        <tr><td>Static site generation</td><td><span className="status available">Available</span></td><td>The build records prerendered route HTML and immutable assets in the verified production artifact.</td></tr>
      </tbody>
    </table>
    <h2>Client island boundary</h2>
    <p>A component beginning with <code>"use client"</code> is hydrated in the browser. Props must be serializable; browser APIs belong in effects, not server render.</p>
    <h2>Evidence boundary</h2>
    <p>Source checks and local captures prove different things. This site labels the pinned Docs Workbench screenshots separately from current-head build, hosted, and production claims.</p>
  </div>;
}
