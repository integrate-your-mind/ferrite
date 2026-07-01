import assert from "node:assert/strict";
import test from "node:test";

import { renderJsonToHtml } from "../index.js";

test("renderJsonToHtml renders compact render packets through the native binding", () => {
  const html = renderJsonToHtml(
    JSON.stringify({
      ferrite: "render-packet",
      version: 1,
      root: [
        2,
        "main",
        { class: "shell", "data-count": 2 },
        [
          [2, "h1", {}, [[0, "Ferrite"]]],
          [0, " native"],
        ],
      ],
    }),
  );

  assert.equal(html, '<main class="shell" data-count="2"><h1>Ferrite</h1> native</main>');
});

test("renderJsonToHtml keeps legacy serialized node compatibility", () => {
  const html = renderJsonToHtml(
    JSON.stringify({
      kind: "element",
      tag: "button",
      props: { type: "button" },
      children: [{ kind: "text", value: "Save" }],
    }),
  );

  assert.equal(html, '<button type="button">Save</button>');
});

test("renderJsonToHtml throws native errors for invalid packets", () => {
  assert.throws(
    () =>
      renderJsonToHtml(
        JSON.stringify({
          ferrite: "render-packet",
          version: 99,
          root: [0, "Bad"],
        }),
      ),
    /unsupported version 99/,
  );
});

test("renderJsonToHtml requires a string argument", () => {
  assert.throws(() => renderJsonToHtml({}), /expects one string argument/);
});
