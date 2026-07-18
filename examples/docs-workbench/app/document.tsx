import type { Child } from "@ferrite/runtime";
import { siteStyles } from "../styles/site";

type DocumentProps = {
  children: Child;
  head: Child;
};

export default function Document({ children, head }: DocumentProps) {
  return (
    <html lang="en" data-ferrite-document="docs-workbench">
      <head>
        {head}
        <style data-ferrite-demo-styles>{siteStyles}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
