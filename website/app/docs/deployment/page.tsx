import DocsNav from "../../components/DocsNav";
import { siteUrl } from "../../metadata";

export const metadata = { title: "Deployment · Ferrite", description: "Ferrite artifact and Sites deployment boundary.", alternates: { canonical: siteUrl("/docs/deployment") } };

export default function Deployment() {
  return <div className="wrap article">
    <p className="kicker">Docs / Deployment</p>
    <h1>Artifacts first. Hosting second.</h1>
    <p>Ferrite can render routes on the server, hydrate them in the browser, or prerender them at build time. The current Cloudflare deployment serves the verified prerendered mode; it does not execute Ferrite's native listener or request-time renderer inside a Worker.</p>
    <DocsNav/>
    <h2>Source build</h2>
    <pre><code>{"cargo run --manifest-path ../Cargo.toml -p ferrite-cli -- build \n  --project website \n  --page-renderer ../packages/runtime/bin/render-page.mjs \n  --client-bundler ../packages/runtime/bin/build-client.mjs"}</code></pre>
    <h2>Sites package</h2>
    <p><code>website/deploy-adapter.mjs</code> validates every declared artifact file, copies prerendered HTML and browser assets to <code>dist/client</code>, preserves the Sites project identity, and emits the hosting package. Deep links resolve to their generated HTML and unknown paths remain real 404 responses.</p>
    <h2>Request-time SSR</h2>
    <p>Run the artifact-only Ferrite server behind a mature TLS proxy and process supervisor when a route needs request-time rendering. Cloudflare request-time SSR requires a dedicated fetch-based adapter and is not claimed by this deployment.</p>
    <div className="notice warning"><b>Operational boundary.</b> Static edge delivery and native request-time SSR are separate deployment contracts. Verify the mode your application uses before shipping.</div>
  </div>;
}
