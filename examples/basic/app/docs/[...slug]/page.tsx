type Props = {
  params: Ferrite.RouteParams["/docs/*slug"];
};

export function generateStaticParams() {
  return [{ slug: ["guide", "intro"] }, { slug: ["api"] }];
}

export function generateMetadata({ params }: Props) {
  const slug = params.slug.join("/");
  return {
    title: `Docs ${slug}`,
    description: `Static docs route for ${slug}.`,
  };
}

export default function DocsPage({ params }: Props) {
  const slug = params.slug.join("/");
  return (
    <article data-route="/docs/*slug">
      <h1>Docs {slug}</h1>
    </article>
  );
}
