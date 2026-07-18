"use client";

import { useState } from "@ferrite/runtime";

export default function WorkbenchNavigation() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="navigation-shell">
      <button
        className="menu-toggle"
        type="button"
        aria-expanded={menuOpen}
        aria-controls="primary-navigation"
        onClick={() => setMenuOpen(!menuOpen)}
      >
        {menuOpen ? "Close" : "Menu"}
      </button>
      <nav id="primary-navigation" className={menuOpen ? "nav-links nav-open" : "nav-links"} aria-label="Primary navigation">
        <a href="/guides/getting-started">Guides</a>
        <a href="/reference/runtime">Reference</a>
        <a href="https://github.com/integrate-your-mind/ferrite">Source <span aria-hidden="true">↗</span></a>
      </nav>
    </div>
  );
}
