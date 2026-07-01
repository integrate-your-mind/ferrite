import PostActions from "./PostActions";

type Props = {
  params: Ferrite.RouteParams["/posts/:id"];
};

export function generateStaticParams() {
  return [{ id: "alpha" }, { id: "beta" }];
}

export function generateMetadata({ params }: Props) {
  return {
    title: `Post ${params.id}`,
    description: `Static post route for ${params.id}.`,
  };
}

export default function PostPage({ params }: Props) {
  return (
    <article data-route="/posts/:id">
      <h1>Post {params.id}</h1>
      <PostActions id={params.id} />
    </article>
  );
}
