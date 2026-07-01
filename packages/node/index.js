import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = dirname(fileURLToPath(import.meta.url));
const bindingPath = process.env.FERRITE_NODE_BINDING || join(packageRoot, "dist", "ferrite-node.node");

if (!existsSync(bindingPath)) {
  throw new Error(
    `Ferrite native binding was not found at ${bindingPath}. Run \`pnpm --filter @ferrite/node build\` first.`,
  );
}

const binding = require(bindingPath);

if (typeof binding.renderJsonToHtml !== "function") {
  throw new TypeError("Ferrite native binding must export renderJsonToHtml(input).");
}

export const renderJsonToHtml = binding.renderJsonToHtml;

export default {
  renderJsonToHtml,
};
