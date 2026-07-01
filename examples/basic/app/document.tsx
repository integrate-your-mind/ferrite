import type { Child } from "@ferrite/runtime";

type Props = {
  children: Child;
  head: Child;
};

export default function Document({ children, head }: Props) {
  return (
    <html lang="en" data-ferrite-document="custom">
      <head>{head}</head>
      <body>{children}</body>
    </html>
  );
}
