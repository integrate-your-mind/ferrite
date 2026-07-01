import { Suspense } from "@ferrite/runtime";

export const metadata = {
  title: "Ferrite Stream Demo",
  description: "Server Suspense fallback and stream chunk route.",
};

async function AsyncPanel() {
  return <strong data-stream="resolved">Async stream content</strong>;
}

export default function StreamDemoPage() {
  return (
    <main data-route="/stream-demo">
      <h1>Streaming demo</h1>
      <Suspense fallback={<p role="status">Loading stream content</p>}>
        <AsyncPanel />
      </Suspense>
    </main>
  );
}
