type ReferenceProps = {
  params: Ferrite.RouteParams["/reference/:id"];
};

const entries: Record<string, { title: string; summary: string; signature: string; status: string }> = {
  runtime: { title: "Runtime facade", summary: "The typed TypeScript-facing layer for Ferrite JSX, hooks, and server/client boundaries.", signature: "@ferrite/runtime", status: "available" },
  router: { title: "Route params", summary: "Generated route types connect app-directory paths to TypeScript page props.", signature: "Ferrite.RouteParams", status: "available" },
};

export function generateStaticParams() {
  return [{ id: "runtime" }, { id: "router" }];
}

export function generateMetadata({ params }: ReferenceProps) {
  const entry = entries[params.id] ?? { title: params.id, summary: "Dynamic reference entry.", signature: "unknown", status: "experimental" };
  return { title: `${entry.title} · Reference`, description: entry.summary };
}

export default function ReferencePage({ params }: ReferenceProps) {
  const entry = entries[params.id] ?? { title: params.id, summary: "This reference id is rendered dynamically from the route parameter.", signature: "unknown", status: "experimental" };
  return (
    <div className="inner-page page-frame"><p className="breadcrumb"><a href="/">Workbench</a> <span aria-hidden="true">/</span> Reference <span aria-hidden="true">/</span> {entry.title}</p><article className="reference-card"><div className="reference-topline"><p className="section-index">Reference / {params.id}</p><span className="status-pill">{entry.status}</span></div><h1>{entry.title}</h1><p className="reading-lede">{entry.summary}</p><div className="reference-signature"><span>symbol</span><code>{entry.signature}</code></div><div className="reference-grid"><div><strong>Route input</strong><p><code>Ferrite.RouteParams["/reference/:id"]</code></p></div><div><strong>Metadata</strong><p>Generated from the same dynamic id.</p></div></div><a className="text-link" href="/guides/architecture">See the architecture guide <span aria-hidden="true">→</span></a></article></div>
  );
}
