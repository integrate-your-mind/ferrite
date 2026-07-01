export const metadata = {
  title: "Ferrite Route Error",
  description: "Route-level error convention demo.",
};

export default function RouteErrorPage() {
  throw new Error("Route error page failed");
}
