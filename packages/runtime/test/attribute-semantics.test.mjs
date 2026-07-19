import assert from "node:assert/strict";
import test from "node:test";

import { Window } from "happy-dom";

import { createElement, toRenderPacket } from "../dist/index.js";
import { hydrate, mount } from "../dist/dom.js";

function AccessibilityProbe() {
  return createElement(
    "div",
    {
      "aria-hidden": false,
      "data-ready": true,
      draggable: false,
      hidden: false,
    },
    createElement("input", { disabled: true, checked: false }),
  );
}

test("render packets preserve string-valued boolean attributes", () => {
  const packet = toRenderPacket(createElement(AccessibilityProbe, null));
  assert.deepEqual(packet.root, [
    2,
    "div",
    {
      "aria-hidden": "false",
      "data-ready": "true",
      draggable: "false",
    },
    [[2, "input", { disabled: true }, []]],
  ]);
});

test("mount and update distinguish ARIA/data booleans from HTML booleans", () => {
  const window = new Window();
  const container = window.document.createElement("div");
  window.document.body.append(container);

  const root = mount(createElement(AccessibilityProbe, null), container);
  const element = container.firstElementChild;
  assert.equal(element?.getAttribute("aria-hidden"), "false");
  assert.equal(element?.getAttribute("data-ready"), "true");
  assert.equal(element?.getAttribute("draggable"), "false");
  assert.equal(element?.hasAttribute("hidden"), false);
  assert.equal(element?.querySelector("input")?.hasAttribute("disabled"), true);
  assert.equal(element?.querySelector("input")?.hasAttribute("checked"), false);

  root.update(
    createElement("div", { "aria-hidden": true, "data-ready": false, hidden: true }),
  );
  assert.equal(container.firstElementChild?.getAttribute("aria-hidden"), "true");
  assert.equal(container.firstElementChild?.getAttribute("data-ready"), "false");
  assert.equal(container.firstElementChild?.hasAttribute("hidden"), true);
});

test("hydration uses the same boolean attribute semantics", () => {
  const window = new Window();
  const container = window.document.createElement("div");
  container.innerHTML = '<div aria-hidden="false" data-ready="true" draggable="false"><input disabled></div>';
  window.document.body.append(container);

  assert.doesNotThrow(() => hydrate(createElement(AccessibilityProbe, null), container));
});
