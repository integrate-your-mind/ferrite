export const metadata = {
  title: "Ferrite Route Loading",
  description: "Route-level loading convention demo.",
};

export default async function RouteLoadingPage() {
  return (
    <main data-route="/route-loading">
      <h1>Route loading resolved</h1>
      <p>This async route is wrapped by its sibling loading file when streamed.</p>
    </main>
  );
}
