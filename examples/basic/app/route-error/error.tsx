function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function ErrorFile({ error }: { error: unknown }) {
  return (
    <main data-route-error="/route-error" role="alert">
      <h1>Route error recovered</h1>
      <p>{errorMessage(error)}</p>
    </main>
  );
}
