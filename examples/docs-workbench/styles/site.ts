export const siteStyles = String.raw`
:root {
  --ink: #20242b;
  --muted: #626d7a;
  --paper: #f5f7f9;
  --white: #ffffff;
  --blue: #155bd7;
  --yellow: #ffd447;
  --line: #d3d9e0;
  --soft-blue: #e7efff;
}

* { box-sizing: border-box; }

html {
  background: var(--paper);
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  scroll-behavior: smooth;
}

body { margin: 0; min-width: 320px; }
a { color: inherit; }
a:focus-visible, button:focus-visible { outline: 3px solid var(--yellow); outline-offset: 3px; }

.skip-link {
  background: var(--yellow);
  color: var(--ink);
  font-size: 14px;
  font-weight: 800;
  left: 16px;
  padding: 12px 16px;
  position: fixed;
  top: 12px;
  transform: translateY(-160%);
  z-index: 20;
}

.skip-link:focus { transform: translateY(0); }
.site-shell { min-height: 100vh; }

.topbar {
  align-items: center;
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  margin: 0 auto;
  max-width: 1440px;
  padding: 16px 5vw;
}

.brand {
  align-items: center;
  display: inline-flex;
  font-size: 14px;
  font-weight: 760;
  gap: 9px;
  letter-spacing: 0;
  min-height: 44px;
  text-decoration: none;
}

.brand-mark {
  align-items: center;
  background: var(--blue);
  border-radius: 50%;
  color: var(--white);
  display: inline-flex;
  font-size: 16px;
  font-weight: 500;
  height: 22px;
  justify-content: center;
  line-height: 1;
  width: 22px;
}

.brand-muted { color: #969faa; margin: 0 2px; }
.navigation-shell { align-items: center; display: flex; }
.nav-links { align-items: center; display: flex; font-size: 13px; gap: 20px; }
.nav-links a { align-items: center; color: var(--muted); display: inline-flex; min-height: 44px; text-decoration: none; }
.nav-links a:hover, .text-link:hover { color: var(--blue); }

.menu-toggle {
  background: none;
  border: 0;
  color: var(--ink);
  cursor: pointer;
  display: none;
  font: inherit;
  font-size: 13px;
  min-height: 44px;
  min-width: 44px;
  padding: 8px;
}

.page-frame { margin: 0 auto; max-width: 1440px; padding-left: 5vw; padding-right: 5vw; }

.hero-grid {
  align-items: center;
  border-bottom: 1px solid var(--line);
  display: grid;
  gap: 8vw;
  grid-template-columns: minmax(0, 0.98fr) minmax(380px, 0.82fr);
  min-height: 615px;
  padding-bottom: 72px;
  padding-top: 74px;
}

.eyebrow, .section-index {
  color: var(--blue);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0;
  margin: 0 0 22px;
  text-transform: uppercase;
}

.signal-dot {
  background: var(--yellow);
  border: 2px solid var(--ink);
  border-radius: 50%;
  display: inline-block;
  height: 9px;
  margin-right: 6px;
  vertical-align: -1px;
  width: 9px;
}

h1, h2, h3, p { margin-top: 0; }
h1, h2, h3 { letter-spacing: 0; }
.hero-copy h1 { font-size: 78px; line-height: 0.98; margin: 0; max-width: 760px; }
.hero-copy h1 em { color: var(--blue); font-style: normal; }

.hero-lede {
  color: var(--muted);
  font-size: 18px;
  line-height: 1.58;
  margin: 32px 0 30px;
  max-width: 585px;
}

.hero-actions { display: flex; flex-wrap: wrap; gap: 10px; }

.button {
  align-items: center;
  border: 1px solid var(--ink);
  border-radius: 4px;
  display: inline-flex;
  font-size: 13px;
  font-weight: 760;
  gap: 15px;
  min-height: 44px;
  padding: 11px 17px;
  text-decoration: none;
}

.button-primary { background: var(--ink); color: var(--white); }
.button-primary:hover { background: var(--blue); border-color: var(--blue); }
.button-secondary { background: transparent; }
.button-secondary:hover { background: var(--white); }

.hero-art { background: var(--ink); min-height: 420px; overflow: hidden; position: relative; }
.hero-art:before { border: 1px solid rgba(255, 255, 255, 0.1); content: ""; inset: 18px; position: absolute; }
.graph-label { color: #aeb7c2; font-size: 11px; font-weight: 800; left: 30px; letter-spacing: 0; position: absolute; top: 25px; }

.graph-node {
  align-items: flex-start;
  border: 1px solid #738092;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 13px 15px;
  position: absolute;
}

.graph-node span, .graph-footnote { color: #b6bec8; font-size: 11px; letter-spacing: 0; text-transform: uppercase; }
.graph-node strong { color: var(--white); font-size: 19px; letter-spacing: 0; }
.graph-node-root { background: var(--blue); border-color: var(--blue); left: 11%; top: 39%; }
.graph-node-static { left: 54%; top: 22%; }
.graph-node-dynamic { left: 54%; top: 61%; }

.graph-line {
  border-top: 1px solid var(--yellow);
  height: 1px;
  left: 35%;
  position: absolute;
  transform-origin: left center;
  width: 20%;
}

.graph-line-one { top: 40%; transform: rotate(-20deg); }
.graph-line-two { top: 52%; transform: rotate(21deg); }
.graph-chip { background: var(--yellow); color: var(--ink); font-size: 11px; font-weight: 800; left: 11%; padding: 7px 9px; position: absolute; top: 65%; }
.graph-footnote { bottom: 24px; left: 30px; position: absolute; }

.signal-strip { border-bottom: 1px solid var(--line); display: grid; grid-template-columns: repeat(3, 1fr); }
.signal-item { border-left: 1px solid var(--line); display: flex; flex-direction: column; gap: 9px; padding: 23px 25px; }
.signal-item:first-child { border-left: 0; }
.signal-item span { color: var(--muted); font-size: 12px; letter-spacing: 0; text-transform: uppercase; }
.signal-item strong { font-size: 16px; }

.content-grid { display: grid; gap: 9vw; grid-template-columns: 0.8fr 1fr; padding-bottom: 110px; padding-top: 112px; }
.content-grid h2, .section-heading h2, .terminal-panel h2 { font-size: 52px; line-height: 1.02; margin: 0; max-width: 530px; }
.prose { color: var(--muted); font-size: 18px; line-height: 1.65; max-width: 600px; }
.prose p + p { margin-top: 23px; }

.cards-section { border-top: 1px solid var(--line); padding-bottom: 110px; padding-top: 95px; }
.section-heading { align-items: end; display: flex; justify-content: space-between; margin-bottom: 44px; }
.section-heading .section-index { margin: 0; }
.surface-cards { display: grid; gap: 14px; grid-template-columns: repeat(3, 1fr); }

.surface-card {
  background: var(--white);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 26px;
}

.surface-card-accent { background: var(--soft-blue); border-color: var(--blue); }
.card-number { color: var(--blue); font-size: 12px; font-weight: 800; }
.surface-card h3 { font-size: 25px; margin: 38px 0 14px; }
.surface-card p { color: var(--muted); font-size: 14px; line-height: 1.6; }
.surface-card a { color: var(--blue); display: inline-block; font-size: 13px; font-weight: 760; margin-top: 12px; min-height: 44px; padding-top: 12px; text-decoration: none; }

code { background: #e8edf2; border-radius: 2px; color: #273a51; font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.86em; padding: 2px 4px; }

.terminal-panel {
  align-items: start;
  background: var(--ink);
  color: var(--white);
  display: grid;
  gap: 8vw;
  margin-left: -5vw;
  margin-right: -5vw;
  padding: 85px 10vw;
}

.terminal-panel .section-index { color: var(--yellow); }
.terminal-panel h2 { color: var(--white); }
.terminal { background: #12151a; border: 1px solid #586270; border-radius: 4px; min-width: 0; overflow: hidden; width: 100%; }
.terminal-bar { align-items: center; background: #2c333c; color: #b2bac4; display: flex; gap: 7px; font-size: 12px; padding: 10px 13px; }
.terminal-bar span { background: #7c8794; border-radius: 50%; height: 7px; width: 7px; }
.terminal-bar b { font-weight: 500; margin-left: 5px; }
.terminal pre { color: #e2e7ec; font: 13px/1.85 "SFMono-Regular", Consolas, monospace; margin: 0; overflow-x: auto; padding: 25px; white-space: pre; }
.terminal-muted { color: #9ca7b4; }

.inner-page { min-height: 700px; padding-bottom: 100px; padding-top: 42px; }
.breadcrumb { color: var(--muted); font-size: 12px; margin-bottom: 74px; }
.breadcrumb a { color: var(--blue); text-decoration: none; }
.reading-layout { display: grid; gap: 10vw; grid-template-columns: 0.65fr 1.4fr; }
.reading-aside { border-top: 2px solid var(--blue); color: var(--muted); padding-top: 17px; }
.reading-aside .section-index { margin-bottom: 13px; }
.reading-aside strong { color: var(--ink); font-size: 16px; }
.reading-aside p:last-child { font-size: 13px; line-height: 1.6; margin-top: 28px; max-width: 210px; }
.reading-content { max-width: 700px; }
.reading-content h1, .reference-card h1 { font-size: 72px; line-height: 0.98; margin: 0 0 25px; }
.reading-lede { color: var(--muted); font-size: 21px; line-height: 1.55; }
.reading-content > p:not(.eyebrow):not(.reading-lede), .callout { color: var(--muted); font-size: 16px; line-height: 1.7; margin-top: 34px; }
.callout { background: var(--soft-blue); border-left: 3px solid var(--blue); padding: 18px 20px; }
.callout strong { color: var(--ink); }
.callout p { margin: 8px 0 0; }
.text-link { color: var(--blue); display: inline-block; font-size: 14px; font-weight: 760; margin-top: 25px; min-height: 44px; padding-top: 12px; text-decoration: none; }

.reference-card {
  background: var(--white);
  border: 1px solid var(--line);
  border-radius: 4px;
  margin-left: auto;
  max-width: 830px;
  padding: 64px;
}

.reference-topline { align-items: center; display: flex; justify-content: space-between; }
.reference-topline .section-index { margin-bottom: 0; }
.status-pill { background: var(--yellow); border-radius: 2px; color: var(--ink); font-size: 12px; font-weight: 800; letter-spacing: 0; padding: 7px 9px; text-transform: uppercase; }
.reference-signature { border-bottom: 1px solid var(--line); border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 10px; margin: 38px 0; padding: 18px 0; }
.reference-signature span { color: var(--muted); font-size: 12px; letter-spacing: 0; text-transform: uppercase; }
.reference-signature code { background: none; color: var(--blue); font-size: 19px; padding: 0; }
.reference-grid { display: grid; gap: 24px; grid-template-columns: repeat(2, 1fr); margin-bottom: 30px; }
.reference-grid strong { font-size: 12px; }
.reference-grid p { color: var(--muted); font-size: 13px; line-height: 1.6; margin-top: 9px; }

.footer {
  border-top: 1px solid var(--line);
  color: var(--muted);
  display: flex;
  font-size: 12px;
  justify-content: space-between;
  margin: 0 auto;
  max-width: 1440px;
  padding: 23px 5vw;
}

@media (max-width: 980px) {
  .hero-grid { gap: 42px; grid-template-columns: 1fr; }
  .hero-copy h1 { font-size: 64px; }
  .hero-art { max-width: 650px; width: 100%; }
  .content-grid, .reading-layout { gap: 40px; grid-template-columns: 1fr; }
  .content-grid h2, .section-heading h2, .terminal-panel h2 { font-size: 42px; }
  .reading-content h1, .reference-card h1 { font-size: 60px; }
  .reading-aside p:last-child { max-width: 420px; }
  .terminal-panel { gap: 42px; grid-template-columns: 1fr; }
  .section-heading { align-items: start; flex-direction: column; gap: 24px; }
}

@media (max-width: 680px) {
  .topbar { padding: 12px 6vw; position: relative; }
  .menu-toggle { display: block; }
  .nav-links { background: var(--white); border: 1px solid var(--line); display: none; flex-direction: column; gap: 0; left: 6vw; padding: 7px; position: absolute; right: 6vw; top: 70px; z-index: 2; }
  .nav-links a { padding: 13px 11px; width: 100%; }
  .nav-open { display: flex; }
  .page-frame { padding-left: 6vw; padding-right: 6vw; }
  .hero-grid { min-height: 0; padding-bottom: 52px; padding-top: 58px; }
  .hero-copy h1 { font-size: 46px; }
  .hero-lede { font-size: 16px; }
  .hero-art { min-height: 330px; }
  .graph-node-static, .graph-node-dynamic { left: 52%; }
  .signal-strip { grid-template-columns: 1fr; }
  .signal-item, .signal-item:first-child { border-left: 0; border-top: 1px solid var(--line); }
  .signal-item:first-child { border-top: 0; }
  .content-grid { padding-bottom: 75px; padding-top: 75px; }
  .content-grid h2, .section-heading h2, .terminal-panel h2 { font-size: 34px; }
  .cards-section { padding-bottom: 75px; padding-top: 70px; }
  .surface-cards { grid-template-columns: 1fr; }
  .terminal-panel { margin-left: -6vw; margin-right: -6vw; padding: 64px 6vw; }
  .terminal pre { font-size: 11px; padding: 18px; }
  .inner-page { padding-top: 32px; }
  .breadcrumb { margin-bottom: 48px; }
  .reading-content h1, .reference-card h1 { font-size: 46px; }
  .reading-lede { font-size: 18px; }
  .reference-card { padding: 32px 24px; }
  .reference-grid { grid-template-columns: 1fr; }
  .footer { flex-direction: column; gap: 8px; padding-left: 6vw; padding-right: 6vw; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
}
`;
