"use client";

import { useState } from "@ferrite/runtime";

export default function MobileMenu({ links }: { links: ReadonlyArray<readonly [string, string]> }) {
  const [open, setOpen] = useState(false);
  return <><button className="menu-button" type="button" aria-expanded={open ? "true" : "false"} aria-controls="mobile-nav" onClick={() => setOpen(!open)}>{open ? "Close" : "Menu"}</button>{open ? <nav id="mobile-nav" className="wrap subnav" aria-label="Mobile navigation">{links.map(([label, href]) => <a href={href} key={href} onClick={() => setOpen(false)}>{label}</a>)}</nav> : null}</>;
}
