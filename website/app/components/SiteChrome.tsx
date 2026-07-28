import type { Child } from "@ferrite/runtime";
import MobileMenu from "./MobileMenu";

const links = [
  ["Docs", "/docs"], ["Examples", "/examples"], ["Compare", "/compare"], ["Blog", "/blog"],
] as const;

export default function SiteChrome({ children }: { children: Child }) {
  return <>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="site-header"><div className="header-inner">
      <a className="brand" href="/" aria-label="Ferrite home"><span className="brand-mark" aria-hidden="true">+</span><span>Ferrite</span></a>
      <nav className="primary-nav" aria-label="Primary navigation">{links.map(([label, href]) => <a href={href} key={href}>{label}</a>)}</nav>
      <a className="header-cta" href="https://github.com/integrate-your-mind/ferrite">View source ↗</a>
      <MobileMenu links={links} />
    </div><noscript><nav className="mobile-nav-fallback wrap subnav" aria-label="Mobile navigation">{links.map(([label, href]) => <a href={href} key={href}>{label}</a>)}</nav></noscript></header>
    <main id="main-content" tabIndex={-1}>{children}</main>
    <footer className="footer"><div className="footer-inner"><span>Ferrite developer preview · source-backed evidence</span><span><a href="/docs/limitations">Read limitations</a> · <a href="/docs/deployment">Deployment boundary</a></span></div></footer>
  </>;
}
