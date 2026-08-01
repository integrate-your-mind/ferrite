import DocsNav from "../../components/DocsNav";
import { siteUrl } from "../../metadata";

export const metadata = { title: "Limitations · Ferrite", description: "Ferrite support and compatibility limitations.", alternates: { canonical: siteUrl("/docs/limitations") } };

export default function Limitations() {
  return <div className="wrap article">
    <p className="kicker">Docs / Limitations</p>
    <h1>Read the gaps before you migrate.</h1>
    <p>Ferrite is an experimental developer preview, not a stable product line. Expect breaking changes and incomplete packages.</p>
    <DocsNav/>
    <table className="table">
      <caption>Ferrite support and compatibility boundaries</caption>
      <thead><tr><th>Area</th><th>Status</th><th>Boundary</th></tr></thead>
      <tbody>
        <tr><td>React compatibility</td><td><span className="status planned">Not drop-in</span></td><td>Different runtime, hooks contract, and serialization rules.</td></tr>
        <tr><td>Server actions</td><td><span className="status partial">Partial</span></td><td>Controls exist; session auth and distributed replay remain incomplete.</td></tr>
        <tr><td>Public distribution</td><td><span className="status planned">Planned</span></td><td>CLI and broad registry onboarding are not a release claim.</td></tr>
        <tr><td>Cloudflare request-time SSR</td><td><span className="status planned">Planned</span></td><td>The current edge deployment serves prerendered HTML and client assets; native Ferrite SSR does not execute inside a Worker.</td></tr>
        <tr><td>Observability</td><td><span className="status experimental">Experimental</span></td><td>Adapter logs are privacy-safe and bounded; no tracing guarantee.</td></tr>
        <tr><td>File uploads / broad platforms</td><td><span className="status planned">Planned</span></td><td>Do not infer support from local examples.</td></tr>
      </tbody>
    </table>
    <div className="notice error"><b>Migration warning.</b> Preserve an escape hatch. Validate route, data, auth, and deployment behavior on your own workload before committing.</div>
  </div>;
}
