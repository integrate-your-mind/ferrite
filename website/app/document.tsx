import type { Child } from "@ferrite/runtime";
import { siteStyles } from "./styles/site";
import { siteUrl } from "./metadata";

export default function Document({ children, head }: { children: Child; head: Child }) {
  return <html lang="en" data-ferrite-document="ferrite-adoption-site"><head>{head}<meta name="twitter:card" content="summary_large_image"/><meta name="twitter:image" content={siteUrl("/og.png")}/><style data-ferrite-site-styles>{siteStyles}</style><style data-ferrite-accessibility>{":where(a,button,input,textarea,select):focus-visible{outline:3px solid #55b9a4;outline-offset:3px}.mobile-nav-fallback{display:none}@media(max-width:800px){.mobile-nav-fallback{display:flex}}.table caption{text-align:left;font-weight:700;color:#637180;padding:0 0 10px}"}</style></head><body>{children}</body></html>;
}
