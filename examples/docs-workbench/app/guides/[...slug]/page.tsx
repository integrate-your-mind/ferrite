type GuideProps = {
  params: Ferrite.RouteParams["/guides/*slug"];
};

const guides: Record<string, { title: string; kicker: string; body: string; next: string }> = {
  "getting-started": {
    title: "Getting started",
    kicker: "A source-build path",
    body: "Install dependencies from the repository, generate route types with ferrite check, and run the development adapter against this app directory.",
    next: "The public CLI and registry packages are not available yet. This example intentionally assumes a repository checkout.",
  },
  architecture: {
    title: "Architecture",
    kicker: "The server-first boundary",
    body: "Ferrite scans the app directory, generates typed route parameters, executes TypeScript page modules, and renders through the Rust SSR boundary. A concrete use client import emits a browser island without turning every route into a client bundle.",
    next: "This is an island-oriented contract, not full React Server Components compatibility.",
  },
};

export function generateStaticParams() {
  return [{ slug: ["getting-started"] }, { slug: ["architecture"] }];
}

export function generateMetadata({ params }: GuideProps) {
  const guide = guides[params.slug.join("-")] ?? guides["getting-started"];
  return { title: `${guide.title} · Ferrite Docs Workbench`, description: guide.body };
}

export default function GuidePage({ params }: GuideProps) {
  const key = params.slug.join("-");
  const guide = guides[key] ?? {
    title: params.slug.join(" / "),
    kicker: "Unlisted guide path",
    body: "This route is rendered from the catch-all parameter and is not one of the pre-rendered guide entries.",
    next: "Add a verified entry before treating this path as documentation content.",
  };

  return (
    <div className="inner-page page-frame">
      <p className="breadcrumb"><a href="/">Workbench</a> <span aria-hidden="true">/</span> Guides <span aria-hidden="true">/</span> {guide.title}</p>
      <article className="reading-layout">
        <aside className="reading-aside"><p className="section-index">Guide</p><strong>{params.slug.join(" / ")}</strong><p>Static path generation is visible in this route’s source.</p></aside>
        <div className="reading-content"><p className="eyebrow"><span className="signal-dot" aria-hidden="true" /> {guide.kicker}</p><h1>{guide.title}</h1><p className="reading-lede">{guide.body}</p><div className="callout"><strong>Verified boundary</strong><p>{guide.next}</p></div><p>Read the source next to the generated output: the route receives <code>Ferrite.RouteParams["/guides/*slug"]</code>, and its known entries come from <code>generateStaticParams</code>.</p><a className="text-link" href="/reference/runtime">Continue to the runtime reference <span aria-hidden="true">→</span></a></div>
      </article>
    </div>
  );
}
