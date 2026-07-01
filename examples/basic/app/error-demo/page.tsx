import { ErrorBoundary, type ErrorBoundaryFallbackProps } from "@ferrite/runtime";

export const metadata = {
  title: "Ferrite Error Demo",
  description: "Error boundary recovery route.",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function DemoFailure() {
  throw new Error("Demo failure recovered by ErrorBoundary");
  return <p>unreachable</p>;
}

function ErrorFallback({ error }: ErrorBoundaryFallbackProps) {
  return (
    <p role="alert" data-error-boundary="recovered">
      Recovered: {errorMessage(error)}
    </p>
  );
}

export default function ErrorDemoPage() {
  return (
    <main data-route="/error-demo">
      <h1>Error boundary demo</h1>
      <ErrorBoundary fallback={ErrorFallback}>
        <DemoFailure />
      </ErrorBoundary>
    </main>
  );
}
