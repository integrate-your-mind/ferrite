import { createServerAction } from "@ferrite/runtime/server";
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
  const savePost = createServerAction({
    id: "app/posts/[id]/page.tsx#savePost",
    routePattern: "/posts/:id",
    async run({ form, routePath }) {
      "use server";
      const title = Array.isArray(form.title) ? form.title[0] ?? "" : form.title ?? "";
      return {
        ok: true,
        routePath,
        title,
      };
    },
  });

  return (
    <article data-route="/posts/:id">
      <h1>Post {params.id}</h1>
      <form action={savePost}>
        <label>
          Title
          <input name="title" defaultValue={`Post ${params.id}`} />
        </label>
        <button type="submit">Save</button>
      </form>
      <PostActions id={params.id} />
    </article>
  );
}
