import type { Child } from "@ferrite/runtime";
import WorkbenchNavigation from "./chrome/WorkbenchChrome";

export const metadata = {
  title: "Ferrite Docs Workbench",
  description: "A source-build Ferrite example for evaluating server-first docs workflows.",
  openGraph: {
    siteName: "Ferrite Docs Workbench",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: Child }) {
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Ferrite Docs Workbench home">
          <span className="brand-mark" aria-hidden="true">+</span>
          <span>Ferrite <span className="brand-muted">/</span> Workbench</span>
        </a>
        <WorkbenchNavigation />
      </header>
      <main id="main-content" tabIndex={-1}>
        <div className="workbench-layout">{children}</div>
      </main>
      <footer className="footer">
        <span>Source-build example · Ferrite private alpha</span>
        <span>Rust control plane · TypeScript surface</span>
      </footer>
    </div>
  );
}
