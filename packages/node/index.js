import { createRequire } from "node:module";

import { resolveNativeBindingPath } from "./binding.js";

const require = createRequire(import.meta.url);
const bindingPath = resolveNativeBindingPath();
const binding = require(bindingPath);

if (typeof binding.renderJsonToHtml !== "function") {
  throw new TypeError("Ferrite native binding must export renderJsonToHtml(input).");
}

export const renderJsonToHtml = binding.renderJsonToHtml;

export default {
  renderJsonToHtml,
};
