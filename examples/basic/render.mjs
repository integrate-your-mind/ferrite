import { createElement, toSerializableNode } from "../../packages/runtime/dist/index.js";

function Counter() {
  return createElement(
    "main",
    { class: "shell", "data-route": "/", onClick: () => undefined },
    createElement("h1", null, "Ferrite"),
    createElement("button", { type: "button" }, "Count: ", 0),
  );
}

const tree = createElement(Counter, null);
const serializable = toSerializableNode(tree);

process.stdout.write(`${JSON.stringify(serializable)}\n`);

