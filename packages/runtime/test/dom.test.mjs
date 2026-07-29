import assert from "node:assert/strict";
import test from "node:test";

import { Window } from "happy-dom";

import {
  ErrorBoundary,
  Fragment,
  Suspense,
  createElement,
  serializableNodeToRenderPacket,
  startTransition,
  toRenderPacket,
  unstable_scheduleCallback,
  unstable_setSchedulerRenderBudget,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  validateServerPayloadPacket,
} from "../dist/index.js";
import {
  applyServerPayload,
  bootstrapServerActionForms,
  createServerPayloadNavigator,
  enhanceServerActionForms,
  fetchAndApplyServerPayload,
  fetchAndApplyServerPayloadStream,
  hydrate,
  hydrateClientReference,
  mount,
  serverPayloadRequestUrl,
  serverPayloadStreamRequestUrl,
} from "../dist/dom.js";
import {
  collectPageMetadata,
  collectStaticParams,
  createClientReference,
  renderDocumentModule,
  renderDocumentModuleToPacket,
  renderDocumentModuleToStreamPacket,
  renderPageModule,
  renderPageModuleToPacket,
  renderPageModuleToServerPayload,
  renderPageModuleToStreamPacket,
} from "../dist/server.js";

function createContainer(url) {
  const window = url ? new Window({ url }) : new Window();
  const container = window.document.createElement("div");
  window.document.body.append(container);
  return { window, container };
}

async function flushScheduledWork() {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function navigationDocumentPayload(route, text, title, headChildren = []) {
  return {
    ferrite: "server-payload",
    version: 1,
    shell: [
      2,
      "html",
      {},
      [
        [2, "head", {}, [[2, "title", {}, [[0, title]]], ...headChildren]],
        [2, "body", {}, [[2, "div", { id: "ferrite-root", "data-route": route }, [[2, "h1", {}, [[0, text]]]]]]],
      ],
    ],
    clientReferences: [],
    chunks: [],
  };
}

function serverPayloadStreamFrame(frame) {
  return {
    ferrite: "server-payload-frame",
    version: 1,
    ...frame,
  };
}

function serverPayloadStreamResponse(frames) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          const line = typeof frame === "string" ? frame : JSON.stringify(frame);
          controller.enqueue(encoder.encode(`${line}\n`));
        }
        controller.close();
      },
    }),
  };
}

test("mount renders function components and updates state from events", () => {
  const { window, container } = createContainer();
  let initializers = 0;

  function Counter() {
    const [count, setCount] = useState(() => {
      initializers += 1;
      return 0;
    });

    return createElement(
      "button",
      {
        type: "button",
        "data-count": count,
        onClick: () => setCount((previous) => previous + 1),
      },
      "Count: ",
      count,
    );
  }

  mount(createElement(Counter, null), container);

  const firstButton = container.querySelector("button");
  assert.equal(firstButton?.textContent, "Count: 0");
  assert.equal(firstButton?.getAttribute("data-count"), "0");

  firstButton?.dispatchEvent(new window.Event("click", { bubbles: true }));

  const updatedButton = container.querySelector("button");
  assert.equal(updatedButton, firstButton);
  assert.equal(updatedButton?.textContent, "Count: 1");
  assert.equal(updatedButton?.getAttribute("data-count"), "1");
  assert.equal(initializers, 1);
});

test("update replaces props and children", () => {
  const { container } = createContainer();

  function Label({ active }) {
    return createElement("div", { className: active ? "on" : "off", hidden: !active }, active ? "On" : "Off");
  }

  const root = mount(createElement(Label, { active: false }), container);

  assert.equal(container.innerHTML, '<div class="off" hidden="">Off</div>');
  const div = container.querySelector("div");

  root.update(createElement(Label, { active: true }));

  assert.equal(container.querySelector("div"), div);
  assert.equal(container.innerHTML, '<div class="on">On</div>');
});

test("update replaces event handlers and removes stale handlers", () => {
  const { window, container } = createContainer();
  const calls = [];
  const root = mount(createElement("button", { onClick: () => calls.push("first") }, "Save"), container);
  const button = container.querySelector("button");

  button?.dispatchEvent(new window.Event("click", { bubbles: true }));
  root.update(createElement("button", { onClick: () => calls.push("second") }, "Save"));
  button?.dispatchEvent(new window.Event("click", { bubbles: true }));
  root.update(createElement("button", null, "Save"));
  button?.dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.equal(container.querySelector("button"), button);
  assert.deepEqual(calls, ["first", "second"]);
});

test("React-compatible onDoubleClick maps to the native dblclick event", () => {
  const { window, container } = createContainer();
  const calls = [];

  mount(
    createElement(
      "button",
      {
        onDoubleClick: () => calls.push("double"),
      },
      "Open",
    ),
    container,
  );

  container
    .querySelector("button")
    ?.dispatchEvent(new window.Event("dblclick", { bubbles: true }));

  assert.deepEqual(calls, ["double"]);
});

test("React-compatible Capture event props run before target and bubble handlers", () => {
  const { window, container } = createContainer();
  const calls = [];

  mount(
    createElement(
      "div",
      {
        onClickCapture: () => calls.push("parent capture"),
        onClick: () => calls.push("parent bubble"),
      },
      createElement(
        "button",
        {
          onClick: () => calls.push("child bubble"),
        },
        "Save",
      ),
    ),
    container,
  );

  container
    .querySelector("button")
    ?.dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.deepEqual(calls, [
    "parent capture",
    "child bubble",
    "parent bubble",
  ]);
});

test("event names that end in Capture remain native event names", () => {
  const { window, container } = createContainer();
  const calls = [];

  mount(
    createElement(
      "button",
      {
        onGotPointerCapture: () => calls.push("got pointer capture"),
      },
      "Drag",
    ),
    container,
  );

  const button = container.querySelector("button");
  button?.dispatchEvent(new window.Event("gotpointer", { bubbles: true }));
  button?.dispatchEvent(new window.Event("gotpointercapture", { bubbles: true }));

  assert.deepEqual(calls, ["got pointer capture"]);
});

test("capture handlers are replaced and removed without changing the DOM node", () => {
  const { window, container } = createContainer();
  const calls = [];
  const root = mount(
    createElement("button", { onClickCapture: () => calls.push("first") }, "Save"),
    container,
  );
  const button = container.querySelector("button");

  button?.dispatchEvent(new window.Event("click", { bubbles: true }));
  root.update(createElement("button", { onClickCapture: () => calls.push("second") }, "Save"));
  button?.dispatchEvent(new window.Event("click", { bubbles: true }));
  root.update(createElement("button", null, "Save"));
  button?.dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.equal(container.querySelector("button"), button);
  assert.deepEqual(calls, ["first", "second"]);
});

test("existing native dblclick event props remain compatible with onDoubleClick", () => {
  const { window, container } = createContainer();
  const calls = [];
  const root = mount(
    createElement("button", { onDblClick: () => calls.push("native") }, "Open"),
    container,
  );
  const button = container.querySelector("button");

  button?.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
  root.update(createElement("button", { onDoubleClick: () => calls.push("react") }, "Open"));
  button?.dispatchEvent(new window.Event("dblclick", { bubbles: true }));

  assert.deepEqual(calls, ["native", "react"]);
});

test("capture event props reject non-function handlers without mutating the current tree", () => {
  const { container } = createContainer();
  const root = mount(createElement("button", { type: "button" }, "Save"), container);
  const button = container.querySelector("button");

  assert.throws(
    () => root.update(createElement("button", { onClickCapture: "not a function" }, "Invalid")),
    /event prop "onClickCapture" must be a function/,
  );
  assert.equal(container.querySelector("button"), button);
  assert.equal(container.innerHTML, '<button type="button">Save</button>');
});

test("keyed child updates reorder existing DOM nodes", () => {
  const { container } = createContainer();

  function List({ items }) {
    return createElement(
      "ul",
      null,
      items.map((item) => createElement("li", { key: item.id, "data-id": item.id }, item.label)),
    );
  }

  const root = mount(
    createElement(List, {
      items: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
        { id: "c", label: "Gamma" },
      ],
    }),
    container,
  );
  const alpha = container.querySelector('[data-id="a"]');
  const beta = container.querySelector('[data-id="b"]');
  const gamma = container.querySelector('[data-id="c"]');

  root.update(
    createElement(List, {
      items: [
        { id: "c", label: "Gamma updated" },
        { id: "a", label: "Alpha updated" },
      ],
    }),
  );

  const items = Array.from(container.querySelectorAll("li"));
  assert.deepEqual(
    items.map((item) => item.getAttribute("data-id")),
    ["c", "a"],
  );
  assert.equal(items[0], gamma);
  assert.equal(items[0].textContent, "Gamma updated");
  assert.equal(items[1], alpha);
  assert.equal(items[1].textContent, "Alpha updated");
  assert.equal(beta?.isConnected, false);
});

test("update replaces incompatible node types", () => {
  const { container } = createContainer();
  const root = mount(createElement("span", null, "Save"), container);
  const span = container.querySelector("span");

  root.update(createElement("button", { type: "button" }, "Save"));

  assert.notEqual(container.querySelector("button"), span);
  assert.equal(container.innerHTML, '<button type="button">Save</button>');
});

test("failed update leaves existing DOM unchanged", () => {
  const { container } = createContainer();
  const root = mount(createElement("button", { type: "button" }, "Save"), container);
  const button = container.querySelector("button");

  assert.throws(
    () => root.update(createElement("button", { type: "button", onClick: "not a function" }, "Bad")),
    /event prop "onClick" must be a function/,
  );

  assert.equal(container.querySelector("button"), button);
  assert.equal(container.innerHTML, '<button type="button">Save</button>');
});

test("fragments and arrays mount without wrapper nodes", () => {
  const { container } = createContainer();

  mount(
    createElement(
      Fragment,
      null,
      createElement("span", null, "A"),
      [false, createElement("span", null, "B"), null],
      "C",
    ),
    container,
  );

  assert.equal(container.innerHTML, "<span>A</span><span>B</span>C");
});

test("Suspense mounts ready children without a wrapper", () => {
  const { container } = createContainer();

  mount(
    createElement(
      Suspense,
      { fallback: createElement("span", null, "Loading") },
      createElement("strong", null, "Ready"),
    ),
    container,
  );

  assert.equal(container.innerHTML, "<strong>Ready</strong>");
});

test("async components fail clearly in the DOM renderer", () => {
  const { container } = createContainer();

  async function AsyncPanel() {
    return createElement("strong", null, "Loaded");
  }

  assert.throws(
    () => mount(createElement(AsyncPanel, null), container),
    /DOM rendering does not support async components/,
  );
  assert.equal(container.innerHTML, "");
});

test("invalid event handler fails before mounting partial UI", () => {
  const { container } = createContainer();

  assert.throws(
    () => mount(createElement("button", { onClick: "not a function" }, "Bad"), container),
    /event prop "onClick" must be a function/,
  );
  assert.equal(container.innerHTML, "");
});

test("ErrorBoundary renders fallback for child render errors", () => {
  const { container } = createContainer();

  function Broken() {
    throw new Error("boom");
  }

  mount(
    createElement(
      ErrorBoundary,
      {
        fallback: ({ error }) => createElement("strong", { role: "alert" }, errorMessage(error)),
      },
      createElement(Broken, null),
    ),
    container,
  );

  assert.equal(container.innerHTML, '<strong role="alert">boom</strong>');
});

test("ErrorBoundary reset retries children", () => {
  const { window, container } = createContainer();

  function Broken({ fail }) {
    if (fail) {
      throw new Error("boom");
    }

    return createElement("span", null, "Recovered");
  }

  function App() {
    const [fail, setFail] = useState(true);
    return createElement(
      ErrorBoundary,
      {
        fallback: ({ reset }) =>
          createElement(
            "button",
            {
              type: "button",
              onClick: () => {
                setFail(false);
                reset();
              },
            },
            "Retry",
          ),
      },
      createElement(Broken, { fail }),
    );
  }

  mount(createElement(App, null), container);
  assert.equal(container.innerHTML, '<button type="button">Retry</button>');

  container.querySelector("button")?.dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.equal(container.innerHTML, "<span>Recovered</span>");
});

test("ErrorBoundary catches render errors caused by transition updates", async () => {
  const { window, container } = createContainer();

  function MaybeBroken({ fail }) {
    if (fail) {
      throw new Error("transition boom");
    }

    return createElement("span", null, "Stable");
  }

  function App() {
    const [fail, setFail] = useState(false);
    return createElement(
      Fragment,
      null,
      createElement(
        "button",
        {
          type: "button",
          onClick: () => startTransition(() => setFail(true)),
        },
        "Break",
      ),
      createElement(
        ErrorBoundary,
        {
          fallback: ({ error }) => createElement("strong", { role: "alert" }, errorMessage(error)),
        },
        createElement(MaybeBroken, { fail }),
      ),
    );
  }

  mount(createElement(App, null), container);
  container.querySelector("button")?.dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.equal(container.querySelector("strong"), null);

  await flushScheduledWork();

  assert.equal(container.querySelector("strong")?.textContent, "transition boom");
});

test("ErrorBoundary requires a fallback prop", () => {
  const { container } = createContainer();

  function Broken() {
    throw new Error("boom");
  }

  assert.throws(
    () => mount(createElement(ErrorBoundary, null, createElement(Broken, null)), container),
    /ErrorBoundary requires a fallback prop/,
  );
});

test("unmount clears DOM and rejects later updates", () => {
  const { container } = createContainer();
  const root = mount(createElement("p", null, "Mounted"), container);

  assert.equal(container.innerHTML, "<p>Mounted</p>");

  root.unmount();

  assert.equal(container.innerHTML, "");
  assert.throws(() => root.update(createElement("p", null, "Again")), /root is unmounted/);
});

test("useState outside render fails clearly", () => {
  assert.throws(() => useState(0), /only be called while rendering/);
});

test("useLayoutEffect outside render fails clearly", () => {
  assert.throws(() => useLayoutEffect(() => undefined, []), /only be called while rendering/);
});

test("useEffect runs after commit and cleans up on dependency changes and unmount", () => {
  const { container } = createContainer();
  const effects = [];
  const cleanups = [];

  function Probe({ value }) {
    useEffect(() => {
      effects.push(value);
      return () => cleanups.push(value);
    }, [value]);

    return createElement("p", null, value);
  }

  const root = mount(createElement(Probe, { value: "one" }), container);
  assert.deepEqual(effects, ["one"]);
  assert.deepEqual(cleanups, []);

  root.update(createElement(Probe, { value: "one" }));
  assert.deepEqual(effects, ["one"]);
  assert.deepEqual(cleanups, []);

  root.update(createElement(Probe, { value: "two" }));
  assert.deepEqual(effects, ["one", "two"]);
  assert.deepEqual(cleanups, ["one"]);

  root.unmount();
  assert.deepEqual(cleanups, ["one", "two"]);
});

test("useEffect cleanup runs when a component is removed", () => {
  const { container } = createContainer();
  const events = [];

  function Child() {
    useEffect(() => {
      events.push("mount");
      return () => events.push("cleanup");
    }, []);

    return createElement("span", null, "Child");
  }

  function App({ show }) {
    return show ? createElement(Child, null) : createElement("p", null, "Empty");
  }

  const root = mount(createElement(App, { show: true }), container);
  assert.deepEqual(events, ["mount"]);

  root.update(createElement(App, { show: false }));

  assert.deepEqual(events, ["mount", "cleanup"]);
  assert.equal(container.innerHTML, "<p>Empty</p>");
});

test("useLayoutEffect runs before passive effects and cleans up first on dependency changes", () => {
  const { container } = createContainer();
  const events = [];

  function Probe({ value }) {
    useEffect(() => {
      events.push(`effect ${value}`);
      return () => events.push(`effect cleanup ${value}`);
    }, [value]);
    useLayoutEffect(() => {
      events.push(`layout ${value}`);
      return () => events.push(`layout cleanup ${value}`);
    }, [value]);

    return createElement("p", null, value);
  }

  const root = mount(createElement(Probe, { value: "one" }), container);
  assert.deepEqual(events, ["layout one", "effect one"]);

  root.update(createElement(Probe, { value: "two" }));
  assert.deepEqual(events, [
    "layout one",
    "effect one",
    "layout cleanup one",
    "layout two",
    "effect cleanup one",
    "effect two",
  ]);

  root.unmount();
  assert.deepEqual(events, [
    "layout one",
    "effect one",
    "layout cleanup one",
    "layout two",
    "effect cleanup one",
    "effect two",
    "layout cleanup two",
    "effect cleanup two",
  ]);
});

test("failed update does not run pending effects or cleanups", () => {
  const { container } = createContainer();
  const events = [];

  function Probe({ fail }) {
    useEffect(() => {
      events.push(fail ? "bad-effect" : "good-effect");
      return () => events.push(fail ? "bad-cleanup" : "good-cleanup");
    }, [fail]);

    return createElement("button", { type: "button", onClick: fail ? "not a function" : undefined }, "Save");
  }

  const root = mount(createElement(Probe, { fail: false }), container);
  assert.deepEqual(events, ["good-effect"]);

  assert.throws(() => root.update(createElement(Probe, { fail: true })), /event prop "onClick" must be a function/);

  assert.deepEqual(events, ["good-effect"]);
  assert.equal(container.innerHTML, '<button type="button">Save</button>');
});

test("server render accepts useEffect without running it", async () => {
  let ran = false;

  function Page() {
    useEffect(() => {
      ran = true;
    }, []);

    return createElement("p", null, "Server");
  }

  const rendered = await renderPageModule({ default: Page });

  assert.equal(ran, false);
  assert.deepEqual(rendered, {
    kind: "element",
    tag: "p",
    props: {},
    children: [{ kind: "text", value: "Server" }],
  });
});

test("server render accepts useLayoutEffect without running it", async () => {
  let ran = false;

  function Page() {
    useLayoutEffect(() => {
      ran = true;
    }, []);

    return createElement("p", null, "Server layout");
  }

  const rendered = await renderPageModule({ default: Page });

  assert.equal(ran, false);
  assert.deepEqual(rendered, {
    kind: "element",
    tag: "p",
    props: {},
    children: [{ kind: "text", value: "Server layout" }],
  });
});

test("createClientReference renders a marked island with server fallback HTML", async () => {
  function IslandButton({ id }) {
    const [likes] = useState(0);
    return createElement(
      "button",
      { type: "button", "data-client-island": "post-actions" },
      `Like ${id}: ${likes}`,
    );
  }

  const PostActions = createClientReference({
    id: "app/posts/[id]/PostActions.tsx#default",
    render: IslandButton,
  });

  function Page() {
    return createElement("article", null, createElement(PostActions, { id: "alpha" }));
  }

  const rendered = await renderPageModule({ default: Page });

  assert.deepEqual(rendered, {
    kind: "element",
    tag: "article",
    props: {},
    children: [
      {
        kind: "element",
        tag: "span",
        props: {
          "data-ferrite-client-reference": "app/posts/[id]/PostActions.tsx#default",
          "data-ferrite-client-props": '{"id":"alpha"}',
          "data-ferrite-client-payload":
            '{"ferrite":"client-reference","version":1,"id":"app/posts/[id]/PostActions.tsx#default","module":"app/posts/[id]/PostActions.tsx","exportName":"default","props":{"id":"alpha"}}',
        },
        children: [
          {
            kind: "element",
            tag: "button",
            props: { type: "button", "data-client-island": "post-actions" },
            children: [{ kind: "text", value: "Like alpha: 0" }],
          },
        ],
      },
    ],
  });
});

test("createClientReference rejects malformed client reference ids", () => {
  assert.throws(
    () =>
      createClientReference({
        id: "app/Action.tsx",
        render: () => createElement("button", { type: "button" }, "Action"),
      }),
    /client reference id must be formatted as module#exportName/,
  );
});

test("createClientReference rejects non JSON-serializable props", async () => {
  const Action = createClientReference({
    id: "app/Action.tsx#default",
    render: () => createElement("button", { type: "button" }, "Action"),
  });

  function Page() {
    return createElement(Action, { onSave: () => undefined });
  }

  await assert.rejects(
    () => renderPageModule({ default: Page }),
    /client reference prop "onSave" must be JSON-serializable/,
  );
});

test("createClientReference renders duplicate references with separate serialized props", async () => {
  function Badge({ id }) {
    return createElement("strong", null, `Post ${id}`);
  }

  const BadgeReference = createClientReference({
    id: "app/Badge.tsx#default",
    render: Badge,
  });

  function Page() {
    return createElement(Fragment, null, createElement(BadgeReference, { id: "alpha" }), createElement(BadgeReference, { id: "beta" }));
  }

  const rendered = await renderPageModule({ default: Page });

  assert.equal(rendered.kind, "fragment");
  assert.equal(rendered.children.length, 2);
  assert.deepEqual(
    rendered.children.map((child) => child.props["data-ferrite-client-props"]),
    ['{"id":"alpha"}', '{"id":"beta"}'],
  );
  assert.deepEqual(
    rendered.children.map((child) => JSON.parse(child.props["data-ferrite-client-payload"]).props),
    [{ id: "alpha" }, { id: "beta" }],
  );
  assert.deepEqual(
    rendered.children.map((child) => child.children[0].children[0].value),
    ["Post alpha", "Post beta"],
  );
});

test("renderPageModuleToServerPayload emits shell client references", async () => {
  function IslandButton({ id }) {
    return createElement("button", { type: "button" }, `Like ${id}: 0`);
  }

  const PostActions = createClientReference({
    id: "app/posts/[id]/PostActions.tsx#default",
    render: IslandButton,
  });

  function Page() {
    return createElement("article", null, createElement(PostActions, { id: "alpha" }));
  }

  const payload = await renderPageModuleToServerPayload({ default: Page });
  const validated = validateServerPayloadPacket(payload);

  assert.equal(validated.ferrite, "server-payload");
  assert.equal(validated.version, 1);
  assert.deepEqual(validated.clientReferences, [
    {
      ferrite: "client-reference",
      version: 1,
      id: "app/posts/[id]/PostActions.tsx#default",
      module: "app/posts/[id]/PostActions.tsx",
      exportName: "default",
      props: { id: "alpha" },
    },
  ]);
  assert.deepEqual(validated.chunks, []);
  assert.deepEqual(validated.shell[0], 2);
});

test("renderPageModuleToServerPayload attaches client references to streamed chunks", async () => {
  function IslandButton({ id }) {
    return createElement("button", { type: "button" }, `Like ${id}: 0`);
  }

  const PostActions = createClientReference({
    id: "app/posts/[id]/PostActions.tsx#default",
    render: IslandButton,
  });

  async function AsyncPanel() {
    return createElement(PostActions, { id: "chunk" });
  }

  function Page() {
    return createElement(
      Suspense,
      { fallback: createElement("span", null, "Loading") },
      createElement(AsyncPanel, null),
    );
  }

  const payload = validateServerPayloadPacket(await renderPageModuleToServerPayload({ default: Page }));

  assert.deepEqual(payload.clientReferences, []);
  assert.equal(payload.chunks.length, 1);
  assert.equal(payload.chunks[0].id, "s0");
  assert.deepEqual(payload.chunks[0].clientReferences, [
    {
      ferrite: "client-reference",
      version: 1,
      id: "app/posts/[id]/PostActions.tsx#default",
      module: "app/posts/[id]/PostActions.tsx",
      exportName: "default",
      props: { id: "chunk" },
    },
  ]);
});

test("renderPageModuleToServerPayload rejects malformed embedded client payloads", async () => {
  function Page() {
    return createElement(
      "span",
      {
        "data-ferrite-client-payload": "not-json",
      },
      "Bad",
    );
  }

  await assert.rejects(
    () => renderPageModuleToServerPayload({ default: Page }),
    /client reference payload must be valid JSON/,
  );
});

test("serverPayloadRequestUrl adds and replaces the payload query flag", () => {
  assert.equal(serverPayloadRequestUrl("/posts/abc"), "/posts/abc?__ferrite_payload=server");
  assert.equal(serverPayloadRequestUrl("/posts/abc", "stream"), "/posts/abc?__ferrite_payload=stream");
  assert.equal(serverPayloadStreamRequestUrl("/posts/abc"), "/posts/abc?__ferrite_payload=stream");
  assert.equal(
    serverPayloadRequestUrl("/posts/abc?tab=comments#section"),
    "/posts/abc?tab=comments&__ferrite_payload=server#section",
  );
  assert.equal(
    serverPayloadStreamRequestUrl("/posts/abc?tab=comments#section"),
    "/posts/abc?tab=comments&__ferrite_payload=stream#section",
  );
  assert.equal(
    serverPayloadRequestUrl("/posts/abc?__ferrite_payload=flight&tab=comments"),
    "/posts/abc?tab=comments&__ferrite_payload=server",
  );
  assert.equal(
    serverPayloadRequestUrl("/posts/abc?__ferrite_payload=flight&tab=comments", "stream"),
    "/posts/abc?tab=comments&__ferrite_payload=stream",
  );

  const url = new URL("https://example.com/posts/abc?tab=comments");
  assert.equal(serverPayloadRequestUrl(url), "https://example.com/posts/abc?tab=comments&__ferrite_payload=server");
  assert.equal(
    serverPayloadRequestUrl(url, "stream"),
    "https://example.com/posts/abc?tab=comments&__ferrite_payload=stream",
  );
  assert.throws(() => serverPayloadRequestUrl("/posts/abc", "flight"), /must be "server" or "stream"/);
});

test("fetchAndApplyServerPayload updates a mounted root from shell and chunks", async () => {
  const { container } = createContainer();
  const root = mount(createElement("main", { "data-route": "/posts/old" }, createElement("h1", null, "Old")), container);
  let requested;
  const payload = {
    ferrite: "server-payload",
    version: 1,
    shell: [
      2,
      "main",
      { "data-route": "/posts/alpha" },
      [
        [2, "h1", {}, [[0, "Post alpha"]]],
        [2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[2, "span", {}, [[0, "Loading"]]]]],
      ],
    ],
    clientReferences: [],
    chunks: [{ id: "s0", root: [2, "strong", { "data-loaded": true }, [[0, "Loaded chunk"]]], clientReferences: [] }],
  };

  const applied = await fetchAndApplyServerPayload(root, "/posts/alpha?tab=old", {
    fetch: async (input) => {
      requested = input;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => payload,
      };
    },
  });

  assert.equal(requested, "/posts/alpha?tab=old&__ferrite_payload=server");
  assert.equal(applied, payload);
  assert.equal(container.querySelector("main")?.getAttribute("data-route"), "/posts/alpha");
  assert.equal(container.querySelector("h1")?.textContent, "Post alpha");
  assert.equal(container.querySelector("strong")?.textContent, "Loaded chunk");
  assert.equal(container.querySelector("strong")?.getAttribute("data-loaded"), "true");
  assert.equal(container.textContent, "Post alphaLoaded chunk");
});

test("applyServerPayload rejects malformed compact nodes without changing DOM", () => {
  const { container } = createContainer();
  const root = mount(createElement("p", null, "Stable"), container);
  const before = container.innerHTML;

  assert.throws(
    () =>
      applyServerPayload(root, {
        ferrite: "server-payload",
        version: 1,
        shell: [9],
        clientReferences: [],
        chunks: [],
      }),
    /unsupported opcode 9/,
  );

  assert.equal(container.innerHTML, before);
});

test("applyServerPayload rejects chunks without matching suspense boundaries", () => {
  const { container } = createContainer();
  const root = mount(createElement("p", null, "Stable"), container);
  const before = container.innerHTML;

  assert.throws(
    () =>
      applyServerPayload(root, {
        ferrite: "server-payload",
        version: 1,
        shell: [2, "main", {}, [[0, "No boundary"]]],
        clientReferences: [],
        chunks: [{ id: "s0", root: [2, "strong", {}, [[0, "Loaded"]]], clientReferences: [] }],
      }),
    /chunk "s0" has no matching suspense boundary/,
  );

  assert.equal(container.innerHTML, before);
});

test("fetchAndApplyServerPayload rejects failed responses without changing DOM", async () => {
  const { container } = createContainer();
  const root = mount(createElement("p", null, "Stable"), container);
  const before = container.innerHTML;

  await assert.rejects(
    () =>
      fetchAndApplyServerPayload(root, "/missing", {
        fetch: async () => ({
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: async () => ({ error: "missing" }),
        }),
      }),
    /failed with 404 Not Found/,
  );

  assert.equal(container.innerHTML, before);
});

test("fetchAndApplyServerPayloadStream commits shell before deferred chunks", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  window.document.head.innerHTML = "<title>Old title</title>";
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  const observed = [];
  const frames = [
    serverPayloadStreamFrame({
      kind: "shell",
      shell: [
        2,
        "html",
        {},
        [
          [2, "head", {}, [[2, "title", {}, [[0, "Stream title"]]]]],
          [
            2,
            "body",
            {},
            [
              [
                2,
                "div",
                { id: "ferrite-root", "data-route": "/posts/stream" },
                [
                  [2, "h1", {}, [[0, "Stream route"]]],
                  [2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[0, "Loading chunk"]]],
                ],
              ],
            ],
          ],
        ],
      ],
      clientReferences: [],
    }),
    serverPayloadStreamFrame({
      kind: "chunk",
      chunk: { id: "s0", root: [2, "strong", {}, [[0, "Loaded chunk"]]], clientReferences: [] },
    }),
  ];
  let requested;

  const packet = await fetchAndApplyServerPayloadStream(root, "/posts/stream", {
    window,
    fetch: async (input) => {
      requested = input;
      return serverPayloadStreamResponse(frames);
    },
    onShell: (shellPacket) => {
      observed.push({
        phase: "shell",
        text: container.textContent,
        title: window.document.title,
        chunks: shellPacket.chunks.length,
      });
    },
    onChunk: (chunk, chunkPacket) => {
      observed.push({
        phase: `chunk:${chunk.id}`,
        text: container.textContent,
        title: window.document.title,
        chunks: chunkPacket.chunks.length,
      });
    },
  });

  assert.equal(requested, "/posts/stream?__ferrite_payload=stream");
  assert.equal(packet.ferrite, "server-payload");
  assert.equal(packet.chunks.length, 1);
  assert.deepEqual(observed, [
    { phase: "shell", text: "Stream routeLoading chunk", title: "Stream title", chunks: 0 },
    { phase: "chunk:s0", text: "Stream routeLoaded chunk", title: "Stream title", chunks: 1 },
  ]);
  assert.equal(container.querySelector("#ferrite-root")?.getAttribute("data-route"), "/posts/stream");
  assert.equal(container.textContent, "Stream routeLoaded chunk");
});

test("fetchAndApplyServerPayloadStream rejects malformed shell frames without mutation", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  window.document.head.innerHTML = "<title>Old title</title>";
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  const headBefore = window.document.head.innerHTML;
  const bodyBefore = container.innerHTML;

  await assert.rejects(
    () =>
      fetchAndApplyServerPayloadStream(root, "/posts/bad", {
        window,
        fetch: async () =>
          serverPayloadStreamResponse([
            serverPayloadStreamFrame({
              kind: "shell",
              shell: [
                2,
                "html",
                {},
                [
                  [2, "head", {}, [[2, "meta", { name: "description", content: { nested: true } }, []]]],
                  [2, "body", {}, [[2, "div", { id: "ferrite-root", "data-route": "/posts/bad" }, [[0, "Bad"]]]]],
                ],
              ],
              clientReferences: [],
            }),
          ]),
      }),
    /prop "content".*must be a string, number, or boolean/,
  );

  assert.equal(window.document.head.innerHTML, headBefore);
  assert.equal(container.innerHTML, bodyBefore);
});

test("fetchAndApplyServerPayloadStream rejects chunk frames before shell", async () => {
  const { container } = createContainer();
  const root = mount(createElement("p", null, "Stable"), container);
  const before = container.innerHTML;

  await assert.rejects(
    () =>
      fetchAndApplyServerPayloadStream(root, "/posts/chunk-first", {
        fetch: async () =>
          serverPayloadStreamResponse([
            serverPayloadStreamFrame({
              kind: "chunk",
              chunk: { id: "s0", root: [2, "strong", {}, [[0, "Loaded"]]], clientReferences: [] },
            }),
          ]),
      }),
    /chunk frame arrived before a shell frame/,
  );

  assert.equal(container.innerHTML, before);
});

test("fetchAndApplyServerPayloadStream reports unmatched chunks after shell commit", async () => {
  const { container } = createContainer();
  const root = mount(createElement("div", { id: "ferrite-root" }, "Old"), container);
  const shellFrames = [
    serverPayloadStreamFrame({
      kind: "shell",
      shell: [2, "div", { id: "ferrite-root", "data-route": "/posts/shell" }, [[0, "Shell committed"]]],
      clientReferences: [],
    }),
    serverPayloadStreamFrame({
      kind: "chunk",
      chunk: { id: "missing", root: [2, "strong", {}, [[0, "Unexpected"]]], clientReferences: [] },
    }),
  ];
  const shellSnapshots = [];

  await assert.rejects(
    () =>
      fetchAndApplyServerPayloadStream(root, "/posts/shell", {
        fetch: async () => serverPayloadStreamResponse(shellFrames),
        onShell: () => shellSnapshots.push(container.innerHTML),
      }),
    /chunk "missing" has no matching suspense boundary/,
  );

  assert.deepEqual(shellSnapshots, ['<div id="ferrite-root" data-route="/posts/shell">Shell committed</div>']);
  assert.equal(container.innerHTML, '<div id="ferrite-root" data-route="/posts/shell">Shell committed</div>');
});

test("fetchAndApplyServerPayloadStream reports invalid JSON after shell commit", async () => {
  const { container } = createContainer();
  const root = mount(createElement("div", { id: "ferrite-root" }, "Old"), container);
  const shellFrame = serverPayloadStreamFrame({
    kind: "shell",
    shell: [2, "div", { id: "ferrite-root", "data-route": "/posts/shell" }, [[0, "Shell committed"]]],
    clientReferences: [],
  });

  await assert.rejects(
    () =>
      fetchAndApplyServerPayloadStream(root, "/posts/shell", {
        fetch: async () => serverPayloadStreamResponse([shellFrame, "{not-json"]),
      }),
    /frame 2 must be valid JSON/,
  );

  assert.equal(container.innerHTML, '<div id="ferrite-root" data-route="/posts/shell">Shell committed</div>');
});

test("server payload navigator applies same-origin document payloads and updates history", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(
    createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, createElement("h1", null, "Old")),
    container,
  );
  let requested;
  const payload = {
    ferrite: "server-payload",
    version: 1,
    shell: [
      2,
      "html",
      { lang: "en" },
      [
        [2, "head", {}, [[2, "title", {}, [[0, "Post next"]]]]],
        [
          2,
          "body",
          {},
          [
            [
              2,
              "div",
              { id: "ferrite-root", "data-route": "/posts/next", "data-route-pattern": "/posts/:id" },
              [
                [2, "h1", {}, [[0, "Post next"]]],
                [2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[0, "Loading"]]],
              ],
            ],
          ],
        ],
      ],
    ],
    clientReferences: [],
    chunks: [{ id: "s0", root: [2, "strong", {}, [[0, "Loaded details"]]], clientReferences: [] }],
  };
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async (input) => {
      requested = input;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => payload,
      };
    },
  });

  const applied = await navigator.navigate("/posts/next?tab=details");

  assert.equal(requested, "https://example.com/posts/next?tab=details&__ferrite_payload=server");
  assert.equal(applied, payload);
  assert.equal(window.location.href, "https://example.com/posts/next?tab=details");
  assert.equal(container.querySelector("#ferrite-root")?.getAttribute("data-route"), "/posts/next");
  assert.equal(container.querySelector("#ferrite-root")?.getAttribute("data-route-pattern"), "/posts/:id");
  assert.equal(container.querySelector("html"), null);
  assert.equal(container.textContent, "Post nextLoaded details");

  navigator.destroy();
});

test("server action form enhancer submits Ferrite action forms through validated fetch responses", async () => {
  const { window, container } = createContainer("https://example.com/posts/abc");
  container.innerHTML = `
    <form action="/_ferrite/action" method="post" class="editor">
      <input type="hidden" name="__ferrite_action" value="app/posts/[id]/page.tsx#savePost">
      <input type="hidden" name="__ferrite_route" value="/posts/abc">
      <input name="title" value="Hello Ferrite">
      <input name="tag" value="rust">
      <input name="tag" value="tsx">
      <button type="submit" name="intent" value="save">Save</button>
    </form>
    <form action="/contact" method="post"><button type="submit">Contact</button></form>
  `;
  const submissions = [];
  const responses = [];
  const enhancer = enhanceServerActionForms(container, {
    window,
    fetch: async (input, init) => {
      const formData = init?.body;
      assert.ok(formData instanceof window.FormData);
      submissions.push({
        input,
        method: init?.method,
        credentials: init?.credentials,
        fields: Array.from(formData.entries()),
      });

      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          ferrite: "server-action-response",
          version: 1,
          status: "ok",
          data: { saved: true },
        }),
      };
    },
    onResponse({ response, form }) {
      responses.push({ response, className: form.className });
    },
  });

  const actionForm = container.querySelector("form.editor");
  const actionSubmit = actionForm.querySelector("button");
  const actionEvent = new window.SubmitEvent("submit", {
    bubbles: true,
    cancelable: true,
    submitter: actionSubmit,
  });
  actionForm.dispatchEvent(actionEvent);
  await flushScheduledWork();

  assert.equal(actionEvent.defaultPrevented, true);
  assert.deepEqual(submissions, [
    {
      input: "https://example.com/_ferrite/action",
      method: "POST",
      credentials: "same-origin",
      fields: [
        ["__ferrite_action", "app/posts/[id]/page.tsx#savePost"],
        ["__ferrite_route", "/posts/abc"],
        ["title", "Hello Ferrite"],
        ["tag", "rust"],
        ["tag", "tsx"],
        ["intent", "save"],
      ],
    },
  ]);
  assert.deepEqual(responses, [
    {
      response: {
        ferrite: "server-action-response",
        version: 1,
        status: "ok",
        data: { saved: true },
      },
      className: "editor",
    },
  ]);

  const normalForm = container.querySelector('form[action="/contact"]');
  const normalEvent = new window.SubmitEvent("submit", { bubbles: true, cancelable: true });
  normalForm.dispatchEvent(normalEvent);
  await flushScheduledWork();

  assert.equal(normalEvent.defaultPrevented, false);
  assert.equal(submissions.length, 1);

  enhancer.destroy();
  actionForm.dispatchEvent(new window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await flushScheduledWork();
  assert.equal(submissions.length, 1);
});

test("server action form enhancer reports invalid action responses", async () => {
  const { window, container } = createContainer("https://example.com/posts/abc");
  container.innerHTML = `
    <form action="/_ferrite/action" method="post">
      <input type="hidden" name="__ferrite_action" value="app/posts/[id]/page.tsx#savePost">
      <input type="hidden" name="__ferrite_route" value="/posts/abc">
      <button type="submit">Save</button>
    </form>
  `;
  const errors = [];
  enhanceServerActionForms(container, {
    window,
    fetch: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ferrite: "not-server-action-response" }),
    }),
    onError({ error, form }) {
      errors.push({ message: errorMessage(error), action: form.action });
    },
  });

  const form = container.querySelector("form");
  const event = new window.SubmitEvent("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  await flushScheduledWork();

  assert.equal(event.defaultPrevented, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /expected ferrite marker "server-action-response"/);
  assert.equal(errors[0].action, "https://example.com/_ferrite/action");
});

test("server action form bootstrap is idempotent for generated entrypoints", async () => {
  const { window, container } = createContainer("https://example.com/posts/abc");
  container.innerHTML = `
    <form action="/_ferrite/action" method="post">
      <input type="hidden" name="__ferrite_action" value="app/posts/[id]/page.tsx#savePost">
      <input type="hidden" name="__ferrite_route" value="/posts/abc">
      <button type="submit">Save</button>
    </form>
  `;
  const submissions = [];
  const fetch = async () => {
    submissions.push("submit");
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        ferrite: "server-action-response",
        version: 1,
        status: "ok",
        data: null,
      }),
    };
  };

  const first = bootstrapServerActionForms(window.document, { window, fetch });
  const second = bootstrapServerActionForms(window.document, { window, fetch });
  assert.equal(first, second);

  const form = container.querySelector("form");
  form.dispatchEvent(new window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await flushScheduledWork();

  assert.deepEqual(submissions, ["submit"]);
  first.destroy();
  form.dispatchEvent(new window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await flushScheduledWork();
  assert.deepEqual(submissions, ["submit"]);
});

test("server payload navigator commits history with the streamed shell", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  window.document.head.innerHTML = "<title>Old title</title>";
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  const encoder = new TextEncoder();
  const requests = [];
  let controller;
  const response = {
    ok: true,
    status: 200,
    statusText: "OK",
    body: new ReadableStream({
      start(innerController) {
        controller = innerController;
      },
    }),
  };
  const navigator = createServerPayloadNavigator(root, {
    window,
    stream: true,
    fetch: async (input) => {
      requests.push(input);
      return response;
    },
  });

  const navigation = navigator.navigate("/posts/stream");
  await flushScheduledWork();

  assert.ok(controller);
  controller.enqueue(
    encoder.encode(
      `${JSON.stringify(
        serverPayloadStreamFrame({
          kind: "shell",
          shell: [
            2,
            "html",
            {},
            [
              [2, "head", {}, [[2, "title", {}, [[0, "Stream title"]]]]],
              [
                2,
                "body",
                {},
                [
                  [
                    2,
                    "div",
                    { id: "ferrite-root", "data-route": "/posts/stream" },
                    [
                      [2, "h1", {}, [[0, "Stream route"]]],
                      [2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[0, "Loading chunk"]]],
                    ],
                  ],
                ],
              ],
            ],
          ],
          clientReferences: [],
        }),
      )}\n`,
    ),
  );
  await flushScheduledWork();

  assert.deepEqual(requests, ["https://example.com/posts/stream?__ferrite_payload=stream"]);
  assert.equal(window.location.href, "https://example.com/posts/stream");
  assert.equal(window.document.title, "Stream title");
  assert.equal(container.textContent, "Stream routeLoading chunk");

  controller.enqueue(
    encoder.encode(
      `${JSON.stringify(
        serverPayloadStreamFrame({
          kind: "chunk",
          chunk: { id: "s0", root: [2, "strong", {}, [[0, "Loaded chunk"]]], clientReferences: [] },
        }),
      )}\n`,
    ),
  );
  controller.close();
  const applied = await navigation;

  assert.equal(applied.chunks.length, 1);
  assert.equal(window.location.href, "https://example.com/posts/stream");
  assert.equal(container.querySelector("#ferrite-root")?.getAttribute("data-route"), "/posts/stream");
  assert.equal(container.textContent, "Stream routeLoaded chunk");

  navigator.destroy();
});

test("server payload navigator falls back to JSON when stream bodies are unavailable", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  const requests = [];
  const payload = navigationDocumentPayload("/posts/fallback", "Fallback route", "Fallback title");
  const navigator = createServerPayloadNavigator(root, {
    window,
    stream: true,
    fetch: async (input) => {
      requests.push(input);
      if (input.endsWith("__ferrite_payload=stream")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: null,
        };
      }

      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => payload,
      };
    },
  });

  const applied = await navigator.navigate("/posts/fallback");

  assert.equal(applied, payload);
  assert.deepEqual(requests, [
    "https://example.com/posts/fallback?__ferrite_payload=stream",
    "https://example.com/posts/fallback?__ferrite_payload=server",
  ]);
  assert.equal(window.location.href, "https://example.com/posts/fallback");
  assert.equal(window.document.title, "Fallback title");
  assert.equal(container.textContent, "Fallback route");

  navigator.destroy();
});

test("server payload navigator intercepts same-origin link clicks", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("main", { "data-route": "/posts/old" }, "Old"), container);
  const link = window.document.createElement("a");
  link.href = "/posts/clicked";
  link.textContent = "Next";
  window.document.body.append(link);
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        ferrite: "server-payload",
        version: 1,
        shell: [2, "main", { "data-route": "/posts/clicked" }, [[0, "Clicked route"]]],
        clientReferences: [],
        chunks: [],
      }),
    }),
  });

  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(event);
  await flushScheduledWork();

  assert.equal(event.defaultPrevented, true);
  assert.equal(window.location.href, "https://example.com/posts/clicked");
  assert.equal(container.textContent, "Clicked route");

  navigator.destroy();
});

test("server payload navigator prefetches and consumes payloads for navigation", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  const requests = [];
  const payload = navigationDocumentPayload("/posts/prefetched", "Prefetched route", "Prefetched title");
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async (input) => {
      requests.push(input);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => payload,
      };
    },
  });

  const prefetched = await navigator.prefetch("/posts/prefetched");

  assert.equal(prefetched, payload);
  assert.deepEqual(requests, ["https://example.com/posts/prefetched?__ferrite_payload=server"]);
  assert.equal(container.innerHTML, '<div id="ferrite-root" data-route="/posts/old">Old</div>');

  const applied = await navigator.navigate("/posts/prefetched");

  assert.equal(applied, payload);
  assert.deepEqual(requests, ["https://example.com/posts/prefetched?__ferrite_payload=server"]);
  assert.equal(window.location.href, "https://example.com/posts/prefetched");
  assert.equal(window.document.title, "Prefetched title");
  assert.equal(container.querySelector("#ferrite-root")?.getAttribute("data-route"), "/posts/prefetched");
  assert.equal(container.textContent, "Prefetched route");

  navigator.destroy();
});

test("server payload navigator stream mode consumes JSON prefetches", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  const requests = [];
  const payload = navigationDocumentPayload("/posts/prefetched", "Prefetched route", "Prefetched title");
  const navigator = createServerPayloadNavigator(root, {
    window,
    stream: true,
    fetch: async (input) => {
      requests.push(input);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => payload,
      };
    },
  });

  const prefetched = await navigator.prefetch("/posts/prefetched");
  const applied = await navigator.navigate("/posts/prefetched");

  assert.equal(prefetched, payload);
  assert.equal(applied, payload);
  assert.deepEqual(requests, ["https://example.com/posts/prefetched?__ferrite_payload=server"]);
  assert.equal(window.location.href, "https://example.com/posts/prefetched");
  assert.equal(window.document.title, "Prefetched title");
  assert.equal(container.textContent, "Prefetched route");

  navigator.destroy();
});

test("server payload navigator prefetches safe links on focus intent", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  const link = window.document.createElement("a");
  link.href = "/posts/focused";
  link.textContent = "Focused";
  window.document.body.append(link);
  const requests = [];
  const payload = navigationDocumentPayload("/posts/focused", "Focused route", "Focused title");
  const navigator = createServerPayloadNavigator(root, {
    window,
    prefetch: true,
    fetch: async (input) => {
      requests.push(input);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => payload,
      };
    },
  });

  link.dispatchEvent(new window.Event("focusin", { bubbles: true }));
  await flushScheduledWork();

  assert.deepEqual(requests, ["https://example.com/posts/focused?__ferrite_payload=server"]);
  assert.equal(container.textContent, "Old");

  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(event);
  await flushScheduledWork();

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(requests, ["https://example.com/posts/focused?__ferrite_payload=server"]);
  assert.equal(window.location.href, "https://example.com/posts/focused");
  assert.equal(window.document.title, "Focused title");
  assert.equal(container.textContent, "Focused route");

  navigator.destroy();
});

test("server payload navigator evicts failed prefetches without mutating DOM", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  let attempts = 0;
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 502,
          statusText: "Bad Gateway",
          json: async () => ({ error: "bad gateway" }),
        };
      }

      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => navigationDocumentPayload("/posts/retry", "Retry route", "Retry title"),
      };
    },
  });

  await assert.rejects(() => navigator.prefetch("/posts/retry"), /failed with 502 Bad Gateway/);

  assert.equal(attempts, 1);
  assert.equal(window.location.href, "https://example.com/posts/old");
  assert.equal(container.innerHTML, '<div id="ferrite-root" data-route="/posts/old">Old</div>');

  await navigator.navigate("/posts/retry");

  assert.equal(attempts, 2);
  assert.equal(window.location.href, "https://example.com/posts/retry");
  assert.equal(window.document.title, "Retry title");
  assert.equal(container.textContent, "Retry route");

  navigator.destroy();
});

test("server payload navigator evicts malformed prefetches without mutating DOM", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  let attempts = 0;
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            ferrite: "not-server-payload",
            version: 1,
            shell: [0, ""],
            clientReferences: [],
            chunks: [],
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => navigationDocumentPayload("/posts/valid", "Valid route", "Valid title"),
      };
    },
  });

  await assert.rejects(() => navigator.prefetch("/posts/valid"), /ferrite marker "server-payload"/);

  assert.equal(attempts, 1);
  assert.equal(window.location.href, "https://example.com/posts/old");
  assert.equal(container.innerHTML, '<div id="ferrite-root" data-route="/posts/old">Old</div>');

  await navigator.navigate("/posts/valid");

  assert.equal(attempts, 2);
  assert.equal(window.location.href, "https://example.com/posts/valid");
  assert.equal(window.document.title, "Valid title");
  assert.equal(container.textContent, "Valid route");

  navigator.destroy();
});

test("server payload navigator does not prefetch bypassed links", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("main", null, "Old"), container);
  let fetchCalls = 0;
  const navigator = createServerPayloadNavigator(root, {
    window,
    prefetch: true,
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => navigationDocumentPayload("/ignored", "Ignored", "Ignored"),
      };
    },
  });
  const cases = [
    { href: "https://other.example/posts/next" },
    { href: "/download", download: "" },
    { href: "/target", target: "_blank" },
    { href: "#section" },
  ];

  for (const entry of cases) {
    const link = window.document.createElement("a");
    link.href = entry.href;
    if ("download" in entry) {
      link.setAttribute("download", entry.download);
    }
    if (entry.target) {
      link.target = entry.target;
    }
    window.document.body.append(link);

    link.dispatchEvent(new window.MouseEvent("pointerover", { bubbles: true }));
    link.dispatchEvent(new window.Event("focusin", { bubbles: true }));
  }

  const external = await navigator.prefetch("https://other.example/posts/next");
  await flushScheduledWork();

  assert.equal(external, null);
  assert.equal(fetchCalls, 0);
  assert.equal(container.textContent, "Old");

  navigator.destroy();
});

test("server payload navigator falls back after failed click payload requests", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("main", { "data-route": "/posts/old" }, "Old"), container);
  const link = window.document.createElement("a");
  link.href = "/missing";
  link.textContent = "Missing";
  window.document.body.append(link);
  const fallbackUrls = [];
  const errors = [];
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ error: "missing" }),
    }),
    fallback: (url) => fallbackUrls.push(url.href),
    onError: (error) => errors.push(error),
  });

  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(event);
  await flushScheduledWork();

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(fallbackUrls, ["https://example.com/missing"]);
  assert.equal(errors.length, 1);
  assert.equal(container.innerHTML, '<main data-route="/posts/old">Old</main>');
  assert.equal(window.location.href, "https://example.com/posts/old");

  navigator.destroy();
});

test("server payload navigator rejects malformed navigation payloads without changing DOM or history", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("main", { "data-route": "/posts/old" }, "Old"), container);
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        ferrite: "server-payload",
        version: 1,
        shell: [9],
        clientReferences: [],
        chunks: [],
      }),
    }),
  });

  await assert.rejects(() => navigator.navigate("/posts/bad"), /unsupported opcode 9/);

  assert.equal(container.innerHTML, '<main data-route="/posts/old">Old</main>');
  assert.equal(window.location.href, "https://example.com/posts/old");

  navigator.destroy();
});

test("server payload navigator bypasses links that should use normal browser navigation", () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("main", null, "Old"), container);
  let fetchCalls = 0;
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ ferrite: "server-payload", version: 1, shell: [0, ""], clientReferences: [], chunks: [] }),
      };
    },
  });
  const cases = [
    { href: "https://other.example/posts/next" },
    { href: "/download", download: "" },
    { href: "/target", target: "_blank" },
    { href: "/modified", metaKey: true },
  ];

  for (const entry of cases) {
    const link = window.document.createElement("a");
    link.href = entry.href;
    if ("download" in entry) {
      link.setAttribute("download", entry.download);
    }
    if (entry.target) {
      link.target = entry.target;
    }
    window.document.body.append(link);

    const event = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: entry.metaKey === true,
    });
    link.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }

  assert.equal(fetchCalls, 0);
  assert.equal(container.textContent, "Old");

  navigator.destroy();
});

test("server payload navigator reconciles managed document head resources", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  window.document.head.innerHTML = `
    <title>Old title</title>
    <meta name="description" content="Old description">
    <meta name="viewport" content="width=device-width">
    <meta property="og:title" content="Old OG">
    <link rel="stylesheet" href="/_ferrite/static/old.css">
    <link rel="preconnect" href="https://cdn.example">
    <script type="module" src="/_ferrite/static/old.js"></script>
    <script src="https://analytics.example/app.js"></script>
  `;
  const root = mount(
    createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, createElement("h1", null, "Old")),
    container,
  );
  const payload = {
    ferrite: "server-payload",
    version: 1,
    shell: [
      2,
      "html",
      { lang: "en" },
      [
        [
          2,
          "head",
          {},
          [
            [2, "title", {}, [[0, "New title"]]],
            [2, "meta", { name: "description", content: "New description" }, []],
            [2, "meta", { property: "og:title", content: "New OG" }, []],
            [2, "meta", { property: "og:image", content: "/first.png" }, []],
            [2, "meta", { property: "og:image", content: "/second.png" }, []],
            [2, "link", { rel: "stylesheet", href: "/_ferrite/static/new.css" }, []],
            [2, "link", { rel: "icon", href: "/favicon-new.svg", type: "image/svg+xml" }, []],
            [2, "script", { type: "module", src: "/_ferrite/static/new.js" }, []],
          ],
        ],
        [
          2,
          "body",
          {},
          [[2, "div", { id: "ferrite-root", "data-route": "/posts/new" }, [[2, "h1", {}, [[0, "New"]]]]]],
        ],
      ],
    ],
    clientReferences: [],
    chunks: [],
  };
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => payload,
    }),
  });

  await navigator.navigate("/posts/new");

  assert.equal(window.document.title, "New title");
  assert.equal(window.document.querySelector('meta[name="description"]')?.getAttribute("content"), "New description");
  assert.equal(window.document.querySelector('meta[name="viewport"]')?.getAttribute("content"), "width=device-width");
  assert.equal(window.document.querySelector('meta[property="og:title"]')?.getAttribute("content"), "New OG");
  assert.deepEqual(
    Array.from(window.document.querySelectorAll('meta[property="og:image"]')).map((node) =>
      node.getAttribute("content"),
    ),
    ["/first.png", "/second.png"],
  );
  assert.equal(window.document.querySelector('link[rel="preconnect"]')?.getAttribute("href"), "https://cdn.example");
  assert.equal(window.document.querySelector('script[src="https://analytics.example/app.js"]') !== null, true);
  assert.equal(window.document.querySelector('link[href="/_ferrite/static/old.css"]'), null);
  assert.equal(window.document.querySelector('script[src="/_ferrite/static/old.js"]'), null);
  assert.equal(
    window.document.querySelector('link[href="/_ferrite/static/new.css"]')?.getAttribute("data-ferrite-head"),
    "managed",
  );
  assert.equal(
    window.document.querySelector('script[src="/_ferrite/static/new.js"]')?.getAttribute("data-ferrite-head"),
    "managed",
  );
  assert.equal(container.textContent, "New");

  navigator.destroy();
});

test("server payload navigator rejects malformed document head payloads without mutation", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  window.document.head.innerHTML = '<title>Old title</title><meta name="viewport" content="width=device-width">';
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  const headBefore = window.document.head.innerHTML;
  const bodyBefore = container.innerHTML;
  const payload = {
    ferrite: "server-payload",
    version: 1,
    shell: [
      2,
      "html",
      {},
      [
        [2, "head", {}, [[2, "meta", { name: "description", content: { nested: true } }, []]]],
        [2, "body", {}, [[2, "div", { id: "ferrite-root", "data-route": "/posts/bad" }, [[0, "Bad"]]]]],
      ],
    ],
    clientReferences: [],
    chunks: [],
  };
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => payload,
    }),
  });

  await assert.rejects(() => navigator.navigate("/posts/bad"), /prop "content".*must be a string, number, or boolean/);

  assert.equal(window.document.head.innerHTML, headBefore);
  assert.equal(container.innerHTML, bodyBefore);
  assert.equal(window.location.href, "https://example.com/posts/old");

  navigator.destroy();
});

test("server payload navigator restores back and forward entries from payload history", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  window.document.head.innerHTML = '<title>Old title</title><meta name="description" content="Old description">';
  const root = mount(
    createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, createElement("h1", null, "Old")),
    container,
  );
  const requests = [];
  const payloads = new Map([
    [
      "https://example.com/posts/old?__ferrite_payload=server",
      navigationDocumentPayload("/posts/old", "Old restored", "Old restored title", [
        [2, "meta", { name: "description", content: "Old restored description" }, []],
      ]),
    ],
    [
      "https://example.com/posts/new?__ferrite_payload=server",
      navigationDocumentPayload("/posts/new", "New route", "New title", [
        [2, "meta", { name: "description", content: "New description" }, []],
      ]),
    ],
  ]);
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async (input) => {
      requests.push(input);
      const payload = payloads.get(input);
      assert.ok(payload, `unexpected payload request ${input}`);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => payload,
      };
    },
  });

  await navigator.navigate("/posts/new");
  assert.equal(window.location.href, "https://example.com/posts/new");
  assert.equal(window.document.title, "New title");
  assert.equal(container.textContent, "New route");

  window.history.back();
  await flushScheduledWork();

  assert.equal(window.location.href, "https://example.com/posts/old");
  assert.equal(window.document.title, "Old restored title");
  assert.equal(window.document.querySelector('meta[name="description"]')?.getAttribute("content"), "Old restored description");
  assert.equal(container.querySelector("#ferrite-root")?.getAttribute("data-route"), "/posts/old");
  assert.equal(container.textContent, "Old restored");

  window.history.forward();
  await flushScheduledWork();

  assert.equal(window.location.href, "https://example.com/posts/new");
  assert.equal(window.document.title, "New title");
  assert.equal(window.document.querySelector('meta[name="description"]')?.getAttribute("content"), "New description");
  assert.equal(container.querySelector("#ferrite-root")?.getAttribute("data-route"), "/posts/new");
  assert.equal(container.textContent, "New route");
  assert.deepEqual(requests, [
    "https://example.com/posts/new?__ferrite_payload=server",
    "https://example.com/posts/old?__ferrite_payload=server",
    "https://example.com/posts/new?__ferrite_payload=server",
  ]);

  navigator.destroy();
});

test("server payload navigator uses stream mode for popstate restoration", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  const requests = [];
  const streams = new Map([
    [
      "https://example.com/posts/old?__ferrite_payload=stream",
      [
        serverPayloadStreamFrame({
          kind: "shell",
          shell: navigationDocumentPayload("/posts/old", "Old restored", "Old restored title").shell,
          clientReferences: [],
        }),
      ],
    ],
    [
      "https://example.com/posts/new?__ferrite_payload=stream",
      [
        serverPayloadStreamFrame({
          kind: "shell",
          shell: navigationDocumentPayload("/posts/new", "New route", "New title").shell,
          clientReferences: [],
        }),
      ],
    ],
  ]);
  const navigator = createServerPayloadNavigator(root, {
    window,
    stream: true,
    fetch: async (input) => {
      requests.push(input);
      const frames = streams.get(input);
      assert.ok(frames, `unexpected stream request ${input}`);
      return serverPayloadStreamResponse(frames);
    },
  });

  await navigator.navigate("/posts/new");
  assert.equal(window.location.href, "https://example.com/posts/new");
  assert.equal(window.document.title, "New title");
  assert.equal(container.textContent, "New route");

  window.history.back();
  await flushScheduledWork();

  assert.equal(window.location.href, "https://example.com/posts/old");
  assert.equal(window.document.title, "Old restored title");
  assert.equal(container.querySelector("#ferrite-root")?.getAttribute("data-route"), "/posts/old");
  assert.equal(container.textContent, "Old restored");
  assert.deepEqual(requests, [
    "https://example.com/posts/new?__ferrite_payload=stream",
    "https://example.com/posts/old?__ferrite_payload=stream",
  ]);

  navigator.destroy();
});

test("server payload navigator falls back when popstate payload requests fail", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  const fallbackUrls = [];
  const errors = [];
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async (input) => {
      if (input === "https://example.com/posts/new?__ferrite_payload=server") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => navigationDocumentPayload("/posts/new", "New route", "New title"),
        };
      }

      return {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => ({ error: "unavailable" }),
      };
    },
    fallback: (url) => fallbackUrls.push(url.href),
    onError: (error) => errors.push(error),
  });

  await navigator.navigate("/posts/new");
  const headBefore = window.document.head.innerHTML;
  const bodyBefore = container.innerHTML;

  window.history.back();
  await flushScheduledWork();

  assert.deepEqual(fallbackUrls, ["https://example.com/posts/old"]);
  assert.equal(errors.length, 1);
  assert.match(errorMessage(errors[0]), /failed with 503 Service Unavailable/);
  assert.equal(window.location.href, "https://example.com/posts/old");
  assert.equal(window.document.head.innerHTML, headBefore);
  assert.equal(container.innerHTML, bodyBefore);

  navigator.destroy();
});

test("server payload navigator rejects malformed popstate payloads without mutation", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  const fallbackUrls = [];
  const errors = [];
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async (input) => {
      if (input === "https://example.com/posts/new?__ferrite_payload=server") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () =>
            navigationDocumentPayload("/posts/new", "New route", "New title", [
              [2, "meta", { name: "description", content: "New description" }, []],
            ]),
        };
      }

      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          ferrite: "server-payload",
          version: 1,
          shell: [
            2,
            "html",
            {},
            [
              [2, "head", {}, [[2, "meta", { name: "description", content: { nested: true } }, []]]],
              [2, "body", {}, [[2, "div", { id: "ferrite-root", "data-route": "/posts/old" }, [[0, "Bad"]]]]],
            ],
          ],
          clientReferences: [],
          chunks: [],
        }),
      };
    },
    fallback: (url) => fallbackUrls.push(url.href),
    onError: (error) => errors.push(error),
  });

  await navigator.navigate("/posts/new");
  const headBefore = window.document.head.innerHTML;
  const bodyBefore = container.innerHTML;

  window.history.back();
  await flushScheduledWork();

  assert.deepEqual(fallbackUrls, ["https://example.com/posts/old"]);
  assert.equal(errors.length, 1);
  assert.match(errorMessage(errors[0]), /prop "content".*must be a string, number, or boolean/);
  assert.equal(window.location.href, "https://example.com/posts/old");
  assert.equal(window.document.head.innerHTML, headBefore);
  assert.equal(container.innerHTML, bodyBefore);

  navigator.destroy();
});

test("server payload navigator ignores popstate entries without Ferrite history state", async () => {
  const { window, container } = createContainer("https://example.com/posts/old");
  const root = mount(createElement("div", { id: "ferrite-root", "data-route": "/posts/old" }, "Old"), container);
  let fetchCalls = 0;
  const fallbackUrls = [];
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => navigationDocumentPayload("/external", "External", "External"),
      };
    },
    fallback: (url) => fallbackUrls.push(url.href),
  });

  window.history.pushState({ external: true }, "", "/external");
  window.dispatchEvent(new window.PopStateEvent("popstate", { state: { external: true } }));
  await flushScheduledWork();

  assert.equal(fetchCalls, 0);
  assert.deepEqual(fallbackUrls, []);
  assert.equal(window.location.href, "https://example.com/external");
  assert.equal(container.innerHTML, '<div id="ferrite-root" data-route="/posts/old">Old</div>');

  navigator.destroy();
});

test("server render serializes ErrorBoundary fallback for child render errors", async () => {
  function Broken() {
    throw new Error("server boom");
  }

  function Page() {
    return createElement(
      ErrorBoundary,
      {
        fallback: ({ error }) => createElement("strong", { role: "alert" }, errorMessage(error)),
      },
      createElement(Broken, null),
    );
  }

  const rendered = await renderPageModule({ default: Page });

  assert.deepEqual(rendered, {
    kind: "element",
    tag: "strong",
    props: { role: "alert" },
    children: [{ kind: "text", value: "server boom" }],
  });
});

test("toRenderPacket emits compact text, fragment, and element nodes", () => {
  const packet = toRenderPacket(
    createElement(
      Fragment,
      null,
      createElement("h1", { className: "title" }, "Ferrite"),
      " bridge",
    ),
  );

  assert.deepEqual(packet, {
    ferrite: "render-packet",
    version: 1,
    root: [1, [[2, "h1", { class: "title" }, [[0, "Ferrite"]]], [0, " bridge"]]],
  });
});

test("form defaults serialize to effective HTML attributes", () => {
  const packet = toRenderPacket(
    createElement("input", {
      name: "title",
      type: "checkbox",
      defaultValue: "Draft",
      defaultChecked: true,
    }),
  );

  assert.deepEqual(packet, {
    ferrite: "render-packet",
    version: 1,
    root: [2, "input", { name: "title", type: "checkbox", value: "Draft", checked: true }, []],
  });
});

test("controlled input props deterministically override default aliases", () => {
  for (const props of [
    { value: "Controlled", defaultValue: "Fallback", checked: false, defaultChecked: true },
    { defaultValue: "Fallback", value: "Controlled", defaultChecked: true, checked: false },
  ]) {
    const packet = toRenderPacket(createElement("input", props));
    assert.deepEqual(packet.root, [2, "input", { value: "Controlled" }, []]);

    const { container } = createContainer();
    const root = mount(createElement("input", props), container);
    const input = container.querySelector("input");
    assert.equal(input?.getAttribute("value"), "Controlled");
    assert.equal(input?.hasAttribute("checked"), false);
    root.unmount();

    const { container: hydrationContainer } = createContainer();
    hydrationContainer.innerHTML = '<input value="Controlled">';
    const serverInput = hydrationContainer.querySelector("input");
    const hydratedRoot = hydrate(createElement("input", props), hydrationContainer);
    assert.equal(hydrationContainer.querySelector("input"), serverInput);
    hydratedRoot.unmount();
  }
});

test("nullish controlled input props fall back to default aliases", () => {
  for (const props of [
    { value: null, defaultValue: "Fallback", checked: undefined, defaultChecked: true },
    { defaultValue: "Fallback", value: null, defaultChecked: true, checked: undefined },
  ]) {
    const packet = toRenderPacket(createElement("input", props));
    assert.deepEqual(packet.root, [2, "input", { value: "Fallback", checked: true }, []]);

    const { container } = createContainer();
    container.innerHTML = '<input value="Fallback" checked>';
    const serverInput = container.querySelector("input");
    const root = hydrate(createElement("input", props), container);
    assert.equal(container.querySelector("input"), serverInput);
    root.unmount();
  }
});

test("intrinsic input tags normalize before default prop serialization", () => {
  const element = createElement("INPUT", { defaultValue: "Draft", defaultChecked: true });
  const packet = toRenderPacket(element);
  assert.deepEqual(packet.root, [2, "input", { value: "Draft", checked: true }, []]);

  const { container } = createContainer();
  const root = mount(element, container);
  const input = container.querySelector("input");
  assert.equal(input?.getAttribute("value"), "Draft");
  assert.equal(input?.hasAttribute("checked"), true);
  root.unmount();
});

test("toRenderPacket uses an empty fragment for empty output", () => {
  assert.deepEqual(toRenderPacket(null), {
    ferrite: "render-packet",
    version: 1,
    root: [1, []],
  });
});

test("toRenderPacket rejects unserializable props before packet output", () => {
  assert.throws(
    () => toRenderPacket(createElement("button", { data: { nested: true } }, "Save")),
    /Cannot serialize prop "data"/,
  );
});

test("renderPageModuleToPacket emits a smaller render packet than legacy JSON", async () => {
  function Page() {
    return createElement(
      "main",
      { className: "shell", "data-count": 2 },
      createElement("h1", null, "Ferrite"),
      createElement("p", null, "Rust bridge"),
    );
  }

  const legacy = await renderPageModule({ default: Page });
  const packet = await renderPageModuleToPacket({ default: Page });

  assert.deepEqual(packet, serializableNodeToRenderPacket(legacy));
  assert.equal(packet.ferrite, "render-packet");
  assert.equal(packet.version, 1);
  assert.ok(JSON.stringify(packet).length < JSON.stringify(legacy).length);
});

test("server render awaits async child components outside Suspense", async () => {
  async function AsyncMessage() {
    return createElement("strong", null, "Loaded");
  }

  function Page() {
    return createElement("main", null, createElement(AsyncMessage, null));
  }

  const rendered = await renderPageModule({ default: Page });

  assert.deepEqual(rendered, {
    kind: "element",
    tag: "main",
    props: {},
    children: [{ kind: "element", tag: "strong", props: {}, children: [{ kind: "text", value: "Loaded" }] }],
  });
});

test("renderPageModuleToStreamPacket emits a Suspense fallback shell and resolved chunk", async () => {
  async function AsyncPanel() {
    return createElement("strong", null, "Loaded");
  }

  function Page() {
    return createElement(
      Suspense,
      { fallback: createElement("span", { role: "status" }, "Loading") },
      createElement(AsyncPanel, null),
    );
  }

  const packet = await renderPageModuleToStreamPacket({ default: Page });

  assert.deepEqual(packet, {
    ferrite: "render-stream",
    version: 1,
    shell: [2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[2, "span", { role: "status" }, [[0, "Loading"]]]]],
    chunks: [{ id: "s0", root: [2, "strong", {}, [[0, "Loaded"]]] }],
  });
});

test("renderPageModuleToStreamPacket keeps ready Suspense content in the shell", async () => {
  function Page() {
    return createElement(
      Suspense,
      { fallback: createElement("span", null, "Loading") },
      createElement("strong", null, "Ready"),
    );
  }

  const packet = await renderPageModuleToStreamPacket({ default: Page });

  assert.deepEqual(packet, {
    ferrite: "render-stream",
    version: 1,
    shell: [2, "strong", {}, [[0, "Ready"]]],
    chunks: [],
  });
});

test("renderPageModuleToStreamPacket rejects async Suspense fallbacks", async () => {
  async function AsyncFallback() {
    return createElement("span", null, "Loading");
  }

  async function AsyncPanel() {
    return createElement("strong", null, "Loaded");
  }

  function Page() {
    return createElement(
      Suspense,
      { fallback: createElement(AsyncFallback, null) },
      createElement(AsyncPanel, null),
    );
  }

  await assert.rejects(
    () => renderPageModuleToStreamPacket({ default: Page }),
    /Suspense fallback must render synchronously/,
  );
});

test("route loading convention streams an async page behind a fallback", async () => {
  async function Page() {
    return createElement("strong", null, "Loaded route");
  }

  function Loading() {
    return createElement("span", { role: "status" }, "Loading route");
  }

  const packet = await renderPageModuleToStreamPacket({ default: Page }, {}, [], {
    loading: { default: Loading },
  });

  assert.deepEqual(packet, {
    ferrite: "render-stream",
    version: 1,
    shell: [2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[2, "span", { role: "status" }, [[0, "Loading route"]]]]],
    chunks: [{ id: "s0", root: [2, "strong", {}, [[0, "Loaded route"]]] }],
  });
});

test("route error convention catches page render failures", async () => {
  function Page() {
    throw new Error("route boom");
  }

  function ErrorFile({ error }) {
    return createElement("strong", { role: "alert" }, errorMessage(error));
  }

  const rendered = await renderPageModule({ default: Page }, {}, [], {
    error: { default: ErrorFile },
  });

  assert.deepEqual(rendered, {
    kind: "element",
    tag: "strong",
    props: { role: "alert" },
    children: [{ kind: "text", value: "route boom" }],
  });
});

test("route loading and error conventions stream rejected async pages as error chunks", async () => {
  async function Page() {
    throw new Error("async route boom");
  }

  function Loading() {
    return createElement("span", null, "Loading route");
  }

  function ErrorFile({ error }) {
    return createElement("strong", { role: "alert" }, errorMessage(error));
  }

  const packet = await renderPageModuleToStreamPacket({ default: Page }, {}, [], {
    loading: { default: Loading },
    error: { default: ErrorFile },
  });

  assert.deepEqual(packet, {
    ferrite: "render-stream",
    version: 1,
    shell: [2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[2, "span", {}, [[0, "Loading route"]]]]],
    chunks: [{ id: "s0", root: [2, "strong", { role: "alert" }, [[0, "async route boom"]]] }],
  });
});

test("collectPageMetadata merges layouts and lets pages override", async () => {
  const metadata = await collectPageMetadata(
    {
      default: () => createElement("p", null, "Page"),
      generateMetadata: ({ params }) => ({
        title: `Post ${params.id}`,
      }),
    },
    { params: { id: "abc" } },
    [
      {
        default: ({ children }) => children,
        metadata: { title: "Site", description: "Site description" },
      },
      {
        default: ({ children }) => children,
        generateMetadata: ({ params }) => ({
          description: `Post ${params.id} description`,
        }),
      },
    ],
  );

  assert.deepEqual(metadata, {
    title: "Post abc",
    description: "Post abc description",
  });
});

test("collectPageMetadata merges rich metadata fields", async () => {
  const metadata = await collectPageMetadata(
    {
      default: () => createElement("p", null, "Page"),
      metadata: {
        openGraph: {
          title: "Page OG",
          images: [{ url: "/page.png", alt: "Page image", width: 1200, height: 630 }],
        },
        icons: [{ url: "/page-icon.svg", type: "image/svg+xml" }],
        alternates: {
          canonical: "https://example.com/page",
          languages: {
            fr: "https://example.com/fr/page",
          },
        },
      },
    },
    {},
    [
      {
        default: ({ children }) => children,
        metadata: {
          openGraph: {
            siteName: "Ferrite",
            type: "website",
            images: ["/layout.png"],
          },
          icons: ["/favicon.ico"],
          alternates: {
            canonical: "https://example.com",
            languages: {
              en: "https://example.com/page",
            },
          },
        },
      },
    ],
  );

  assert.deepEqual(metadata, {
    openGraph: {
      siteName: "Ferrite",
      type: "website",
      title: "Page OG",
      images: [{ url: "/page.png", alt: "Page image", width: 1200, height: 630 }],
    },
    icons: [{ url: "/favicon.ico" }, { url: "/page-icon.svg", type: "image/svg+xml" }],
    alternates: {
      canonical: "https://example.com/page",
      languages: {
        en: "https://example.com/page",
        fr: "https://example.com/fr/page",
      },
    },
  });
});

test("collectPageMetadata rejects malformed metadata", async () => {
  await assert.rejects(
    () =>
      collectPageMetadata({
        default: () => createElement("p", null, "Page"),
        metadata: { title: 42 },
      }),
    /metadata\.title must be a string/,
  );
});

test("collectPageMetadata rejects malformed rich metadata", async () => {
  await assert.rejects(
    () =>
      collectPageMetadata({
        default: () => createElement("p", null, "Page"),
        metadata: { openGraph: { images: [{ url: "/og.png", width: 1.5 }] } },
      }),
    /openGraph\.images\[0\]\.width must be a non-negative integer/,
  );

  await assert.rejects(
    () =>
      collectPageMetadata({
        default: () => createElement("p", null, "Page"),
        metadata: { icons: [{ rel: "icon" }] },
      }),
    /metadata\.icons\[0\]\.url must be a string/,
  );

  await assert.rejects(
    () =>
      collectPageMetadata({
        default: () => createElement("p", null, "Page"),
        metadata: { alternates: { languages: { en: 42 } } },
      }),
    /metadata\.alternates\.languages\.en must be a string/,
  );
});

test("collectPageMetadata validates generated metadata before static fallback", async () => {
  await assert.rejects(
    () =>
      collectPageMetadata({
        default: () => createElement("p", null, "Page"),
        metadata: { title: "Static" },
        generateMetadata: () => null,
      }),
    /metadata must be an object/,
  );
});

test("collectPageMetadata rejects non-function generateMetadata exports", async () => {
  await assert.rejects(
    () =>
      collectPageMetadata({
        default: () => createElement("p", null, "Page"),
        generateMetadata: "bad",
      }),
    /generateMetadata export must be a function/,
  );
});

test("collectStaticParams accepts catch-all arrays and omits undefined optionals", async () => {
  const result = await collectStaticParams({
    default: () => createElement("p", null, "Page"),
    generateStaticParams: () => [{ slug: ["guide", "intro"], tag: "rust", optional: undefined }],
  });

  assert.deepEqual(result, {
    has_generate_static_params: true,
    params: [{ slug: ["guide", "intro"], tag: "rust" }],
  });
});

test("collectStaticParams rejects non-string catch-all array entries", async () => {
  await assert.rejects(
    () =>
      collectStaticParams({
        default: () => createElement("p", null, "Page"),
        generateStaticParams: () => [{ slug: ["guide", 1] }],
      }),
    /array values must be strings/,
  );
});

test("renderDocumentModule composes head and hydration root", async () => {
  function Page() {
    return createElement("main", null, "Page");
  }

  function Document({ head, children }) {
    return createElement(
      "html",
      { lang: "en", "data-document": "custom" },
      createElement("head", null, head),
      createElement("body", null, children),
    );
  }

  const rendered = await renderDocumentModule({ default: Page }, { params: { id: "home" } }, [], { default: Document }, {
    rootId: "ferrite-root",
    routePath: "/",
    metadata: { title: "Home", description: "Home route" },
    preloadScripts: ["/app.js"],
    styles: ["/app.css"],
    scripts: ["/app.js"],
    defaultTitle: "Fallback",
  });

  assert.deepEqual(rendered, {
    kind: "element",
    tag: "html",
    props: { lang: "en", "data-document": "custom" },
    children: [
      {
        kind: "element",
        tag: "head",
        props: {},
        children: [
          { kind: "element", tag: "meta", props: { charset: "utf-8" }, children: [] },
          { kind: "element", tag: "title", props: {}, children: [{ kind: "text", value: "Home" }] },
          {
            kind: "element",
            tag: "meta",
            props: { name: "description", content: "Home route" },
            children: [],
          },
          { kind: "element", tag: "link", props: { rel: "modulepreload", href: "/app.js" }, children: [] },
          { kind: "element", tag: "link", props: { rel: "stylesheet", href: "/app.css" }, children: [] },
          { kind: "element", tag: "script", props: { type: "module", src: "/app.js" }, children: [] },
        ],
      },
      {
        kind: "element",
        tag: "body",
        props: {},
        children: [
          {
            kind: "element",
            tag: "div",
            props: {
              id: "ferrite-root",
              "data-route": "/",
              "data-ferrite-page-props": '{"params":{"id":"home"}}',
            },
            children: [
              {
                kind: "element",
                tag: "main",
                props: {},
                children: [{ kind: "text", value: "Page" }],
              },
            ],
          },
        ],
      },
    ],
  });
});

test("renderDocumentModuleToPacket wraps document output in a render packet", async () => {
  function Page() {
    return createElement("main", null, "Page");
  }

  function Document({ children }) {
    return createElement("html", null, createElement("body", null, children));
  }

  const packet = await renderDocumentModuleToPacket({ default: Page }, {}, [], { default: Document }, {
    rootId: "ferrite-root",
    routePath: "/packet",
    metadata: {},
  });

  assert.deepEqual(packet, {
    ferrite: "render-packet",
    version: 1,
    root: [
      2,
      "html",
      {},
      [
        [
          2,
          "body",
          {},
          [
            [
              2,
              "div",
              { id: "ferrite-root", "data-route": "/packet", "data-ferrite-page-props": "{}" },
              [[2, "main", {}, [[0, "Page"]]]],
            ],
          ],
        ],
      ],
    ],
  });
});

test("renderDocumentModuleToStreamPacket streams page Suspense chunks inside the document shell", async () => {
  async function AsyncPanel() {
    return createElement("strong", null, "Loaded");
  }

  function Page() {
    return createElement(
      Suspense,
      { fallback: createElement("span", null, "Loading") },
      createElement(AsyncPanel, null),
    );
  }

  function Document({ children }) {
    return createElement("html", null, createElement("body", null, children));
  }

  const packet = await renderDocumentModuleToStreamPacket({ default: Page }, {}, [], { default: Document }, {
    rootId: "ferrite-root",
    routePath: "/stream",
    metadata: {},
  });

  assert.deepEqual(packet, {
    ferrite: "render-stream",
    version: 1,
    shell: [
      2,
      "html",
      {},
      [
        [
          2,
          "body",
          {},
          [
            [
              2,
              "div",
              { id: "ferrite-root", "data-route": "/stream", "data-ferrite-page-props": "{}" },
              [[2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[2, "span", {}, [[0, "Loading"]]]]]],
            ],
          ],
        ],
      ],
    ],
    chunks: [{ id: "s0", root: [2, "strong", {}, [[0, "Loaded"]]] }],
  });
});

test("renderDocumentModule emits rich metadata head tags", async () => {
  function Page() {
    return createElement("main", null, "Page");
  }

  function Document({ head, children }) {
    return createElement("html", null, createElement("head", null, head), createElement("body", null, children));
  }

  const rendered = await renderDocumentModule({ default: Page }, {}, [], { default: Document }, {
    rootId: "ferrite-root",
    routePath: "/",
    metadata: {
      title: "Home",
      openGraph: {
        title: "Home OG",
        url: "https://example.com/",
        siteName: "Ferrite",
        type: "website",
        images: [{ url: "/og.png", alt: "OG", width: 1200, height: 630 }],
      },
      icons: [{ url: "/favicon.svg", type: "image/svg+xml", sizes: "any" }],
      alternates: {
        canonical: "https://example.com/",
        languages: {
          en: "https://example.com/",
        },
      },
    },
  });

  assert.deepEqual(rendered.children[0].children.slice(0, 12), [
    { kind: "element", tag: "meta", props: { charset: "utf-8" }, children: [] },
    { kind: "element", tag: "title", props: {}, children: [{ kind: "text", value: "Home" }] },
    { kind: "element", tag: "meta", props: { property: "og:title", content: "Home OG" }, children: [] },
    { kind: "element", tag: "meta", props: { property: "og:url", content: "https://example.com/" }, children: [] },
    { kind: "element", tag: "meta", props: { property: "og:site_name", content: "Ferrite" }, children: [] },
    { kind: "element", tag: "meta", props: { property: "og:type", content: "website" }, children: [] },
    { kind: "element", tag: "meta", props: { property: "og:image", content: "/og.png" }, children: [] },
    { kind: "element", tag: "meta", props: { property: "og:image:alt", content: "OG" }, children: [] },
    { kind: "element", tag: "meta", props: { property: "og:image:width", content: 1200 }, children: [] },
    { kind: "element", tag: "meta", props: { property: "og:image:height", content: 630 }, children: [] },
    {
      kind: "element",
      tag: "link",
      props: { rel: "icon", href: "/favicon.svg", type: "image/svg+xml", sizes: "any" },
      children: [],
    },
    { kind: "element", tag: "link", props: { rel: "canonical", href: "https://example.com/" }, children: [] },
  ]);
});

test("renderDocumentModule rejects non-html documents", async () => {
  await assert.rejects(
    () =>
      renderDocumentModule(
        { default: () => createElement("main", null, "Page") },
        {},
        [],
        { default: ({ children }) => createElement("div", null, children) },
        { rootId: "ferrite-root", routePath: "/", defaultTitle: "Ferrite" },
      ),
    /must render an <html> element/,
  );
});

test("useRef preserves a mutable object across renders", () => {
  const { container } = createContainer();
  const refs = [];

  function Probe({ label }) {
    const ref = useRef(0);
    ref.current += 1;
    refs.push(ref);
    return createElement("p", null, `${label}:${ref.current}`);
  }

  const root = mount(createElement(Probe, { label: "A" }), container);
  assert.equal(container.textContent, "A:1");

  root.update(createElement(Probe, { label: "B" }));

  assert.equal(container.textContent, "B:2");
  assert.equal(refs[0], refs[1]);
});

test("useMemo and useCallback reuse values until dependencies change", () => {
  const { container } = createContainer();
  let computations = 0;
  const callbacks = [];

  function Probe({ value }) {
    const memo = useMemo(() => {
      computations += 1;
      return value.toUpperCase();
    }, [value]);
    const callback = useCallback(() => memo, [memo]);
    callbacks.push(callback);
    return createElement("p", null, memo);
  }

  const root = mount(createElement(Probe, { value: "one" }), container);
  assert.equal(container.textContent, "ONE");
  assert.equal(computations, 1);

  root.update(createElement(Probe, { value: "one" }));
  assert.equal(container.textContent, "ONE");
  assert.equal(computations, 1);
  assert.equal(callbacks[0], callbacks[1]);

  root.update(createElement(Probe, { value: "two" }));
  assert.equal(container.textContent, "TWO");
  assert.equal(computations, 2);
  assert.notEqual(callbacks[1], callbacks[2]);
});

test("server render accepts useRef and useMemo", async () => {
  function Page() {
    const ref = useRef("server");
    const value = useMemo(() => ref.current.toUpperCase(), [ref.current]);
    return createElement("p", null, value);
  }

  const rendered = await renderPageModule({ default: Page });

  assert.deepEqual(rendered, {
    kind: "element",
    tag: "p",
    props: {},
    children: [{ kind: "text", value: "SERVER" }],
  });
});

test("startTransition defers state updates to a later scheduler task", async () => {
  const { window, container } = createContainer();

  function Counter() {
    const [count, setCount] = useState(0);
    return createElement(
      "button",
      {
        onClick: () => startTransition(() => setCount((previous) => previous + 1)),
      },
      `Count: ${count}`,
    );
  }

  mount(createElement(Counter, null), container);

  const button = container.querySelector("button");
  button?.dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.equal(container.textContent, "Count: 0");

  await flushScheduledWork();

  assert.equal(container.textContent, "Count: 1");
});

test("scheduler runs sync callbacks before transition callbacks", async () => {
  const events = [];

  unstable_scheduleCallback("transition", () => events.push("transition"));
  unstable_scheduleCallback("sync", () => events.push("sync"));

  assert.deepEqual(events, ["sync"]);

  await flushScheduledWork();

  assert.deepEqual(events, ["sync", "transition"]);
});

test("transition render can yield before committing DOM", async () => {
  const { window, container } = createContainer();

  function Panel() {
    const [label, setLabel] = useState("idle");
    const [pending, start] = useTransition();
    return createElement(
      "button",
      {
        type: "button",
        onClick: () => start(() => setLabel("done")),
      },
      pending ? `Pending ${label}` : `Ready ${label}`,
    );
  }

  mount(createElement(Panel, null), container);
  const button = container.querySelector("button");

  unstable_setSchedulerRenderBudget(0);
  try {
    button?.dispatchEvent(new window.Event("click", { bubbles: true }));

    assert.equal(container.textContent, "Pending idle");

    await flushScheduledWork();

    assert.equal(container.textContent, "Pending idle");

    unstable_setSchedulerRenderBudget(null);
    await flushScheduledWork();

    assert.equal(container.textContent, "Ready done");
  } finally {
    unstable_setSchedulerRenderBudget(null);
  }
});

test("useTransition exposes pending state around deferred updates", async () => {
  const { window, container } = createContainer();

  function Panel() {
    const [label, setLabel] = useState("idle");
    const [pending, start] = useTransition();
    return createElement(
      "button",
      {
        "data-pending": pending ? "yes" : "no",
        onClick: () => start(() => setLabel("done")),
      },
      pending ? `Pending ${label}` : `Ready ${label}`,
    );
  }

  mount(createElement(Panel, null), container);
  const button = container.querySelector("button");

  button?.dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.equal(container.querySelector("button")?.getAttribute("data-pending"), "yes");
  assert.equal(container.textContent, "Pending idle");

  await flushScheduledWork();

  assert.equal(container.querySelector("button")?.getAttribute("data-pending"), "no");
  assert.equal(container.textContent, "Ready done");
});

test("urgent updates commit before transition updates", async () => {
  const { window, container } = createContainer();

  function Panel() {
    const [urgent, setUrgent] = useState("old urgent");
    const [slow, setSlow] = useState("old slow");
    return createElement(
      "button",
      {
        onClick: () => {
          startTransition(() => setSlow("new slow"));
          setUrgent("new urgent");
        },
      },
      `${urgent} / ${slow}`,
    );
  }

  mount(createElement(Panel, null), container);
  const button = container.querySelector("button");

  button?.dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.equal(container.textContent, "new urgent / old slow");

  await flushScheduledWork();

  assert.equal(container.textContent, "new urgent / new slow");
});

test("useDeferredValue lags behind urgent values until transition flush", async () => {
  const { window, container } = createContainer();

  function Search() {
    const [query, setQuery] = useState("alpha");
    const deferred = useDeferredValue(query);
    return createElement(
      "button",
      {
        onClick: () => setQuery("beta"),
      },
      `${query} / ${deferred}`,
    );
  }

  mount(createElement(Search, null), container);
  const button = container.querySelector("button");

  button?.dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.equal(container.textContent, "beta / alpha");

  await flushScheduledWork();

  assert.equal(container.textContent, "beta / beta");
});

test("server render accepts transition hooks without scheduling", async () => {
  function Page() {
    const [pending] = useTransition();
    const value = useDeferredValue("server");
    return createElement("p", null, `${pending ? "pending" : "ready"}:${value}`);
  }

  const rendered = await renderPageModule({ default: Page });

  assert.deepEqual(rendered, {
    kind: "element",
    tag: "p",
    props: {},
    children: [{ kind: "text", value: "ready:server" }],
  });
});

test("startTransition rejects non-functions", () => {
  assert.throws(() => startTransition(null), /requires a function/);
});

test("scheduler render budget rejects invalid values", () => {
  assert.throws(() => unstable_setSchedulerRenderBudget(1.5), /must be an integer/);
  assert.throws(() => unstable_setSchedulerRenderBudget(-1), /must be non-negative/);
});

test("transition updates are ignored after unmount", async () => {
  const { window, container } = createContainer();

  function Counter() {
    const [count, setCount] = useState(0);
    return createElement(
      "button",
      {
        onClick: () => startTransition(() => setCount(count + 1)),
      },
      `Count: ${count}`,
    );
  }

  const root = mount(createElement(Counter, null), container);
  const button = container.querySelector("button");

  button?.dispatchEvent(new window.Event("click", { bubbles: true }));
  root.unmount();
  await flushScheduledWork();

  assert.equal(container.innerHTML, "");
});

test("thrown transition scopes reset transition mode", () => {
  const { container } = createContainer();
  let setCount;

  function Counter() {
    const [count, nextSetCount] = useState(0);
    setCount = nextSetCount;
    return createElement("p", null, `Count: ${count}`);
  }

  mount(createElement(Counter, null), container);

  assert.throws(
    () =>
      startTransition(() => {
        throw new Error("transition failed");
      }),
    /transition failed/,
  );

  setCount(1);

  assert.equal(container.textContent, "Count: 1");
});

test("hydrate attaches event handlers without replacing matching DOM", () => {
  const { window, container } = createContainer();
  container.innerHTML = '<button type="button" data-count="0">Count: 0</button>';
  const serverButton = container.querySelector("button");
  let initializers = 0;

  function Counter() {
    const [count, setCount] = useState(() => {
      initializers += 1;
      return 0;
    });

    return createElement(
      "button",
      {
        type: "button",
        "data-count": count,
        onClick: () => setCount((previous) => previous + 1),
      },
      "Count: ",
      count,
    );
  }

  hydrate(createElement(Counter, null), container);

  assert.equal(container.querySelector("button"), serverButton);
  assert.equal(initializers, 1);

  serverButton?.dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.equal(container.querySelector("button")?.textContent, "Count: 1");
  assert.equal(container.querySelector("button")?.getAttribute("data-count"), "1");
});

test("hydrateClientReference hydrates matching marked islands", () => {
  const { window, container } = createContainer();
  container.innerHTML =
    '<span data-ferrite-client-reference="app/Button.tsx#default" data-ferrite-client-props="{&quot;id&quot;:&quot;legacy&quot;}"><button type="button">Like payload: 0</button></span>';
  const island = container.querySelector("[data-ferrite-client-reference]");
  island?.setAttribute(
    "data-ferrite-client-payload",
    JSON.stringify({
      ferrite: "client-reference",
      version: 1,
      id: "app/Button.tsx#default",
      module: "app/Button.tsx",
      exportName: "default",
      props: { id: "payload" },
    }),
  );
  const serverButton = container.querySelector("button");

  function IslandButton({ id }) {
    const [likes, setLikes] = useState(0);
    return createElement("button", { type: "button", onClick: () => setLikes(likes + 1) }, `Like ${id}: ${likes}`);
  }

  const handles = hydrateClientReference(
    {
      id: "app/Button.tsx#default",
      module: "app/Button.tsx",
      exportName: "default",
      component: IslandButton,
    },
    container,
  );

  assert.equal(handles.length, 1);
  assert.equal(container.querySelector("button"), serverButton);
  assert.equal(island?.getAttribute("data-ferrite-client-hydrated"), "true");

  serverButton?.dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.equal(container.querySelector("button")?.textContent, "Like payload: 1");
});

test("hydrateClientReference returns no handles when no marker matches", () => {
  const { container } = createContainer();
  container.innerHTML = '<span data-ferrite-client-reference="app/Other.tsx#default"><button>Other</button></span>';

  const handles = hydrateClientReference(
    {
      id: "app/Button.tsx#default",
      component: () => createElement("button", null, "Missing"),
    },
    container,
  );

  assert.deepEqual(handles, []);
  assert.equal(container.textContent, "Other");
});

test("hydrateClientReference rejects malformed serialized props", () => {
  const { container } = createContainer();
  container.innerHTML =
    '<span data-ferrite-client-reference="app/Button.tsx#default" data-ferrite-client-props="not-json"><button>Bad</button></span>';

  assert.throws(
    () =>
      hydrateClientReference(
        {
          id: "app/Button.tsx#default",
          component: () => createElement("button", null, "Bad"),
        },
        container,
      ),
    /client reference props must be valid JSON/,
  );
  assert.equal(container.querySelector("[data-ferrite-client-hydrated]"), null);
});

test("hydrateClientReference rejects mismatched versioned payload ids", () => {
  const { container } = createContainer();
  container.innerHTML =
    '<span data-ferrite-client-reference="app/Button.tsx#default"><button>Bad</button></span>';
  const island = container.querySelector("[data-ferrite-client-reference]");
  island?.setAttribute(
    "data-ferrite-client-payload",
    JSON.stringify({
      ferrite: "client-reference",
      version: 1,
      id: "app/Other.tsx#default",
      module: "app/Other.tsx",
      exportName: "default",
      props: {},
    }),
  );

  assert.throws(
    () =>
      hydrateClientReference(
        {
          id: "app/Button.tsx#default",
          component: () => createElement("button", null, "Bad"),
        },
        container,
      ),
    /payload id "app\/Other.tsx#default" does not match marker "app\/Button.tsx#default"/,
  );
  assert.equal(container.querySelector("[data-ferrite-client-hydrated]"), null);
});

test("hydrate attaches ErrorBoundary fallback rendered by the server", () => {
  const { container } = createContainer();
  container.innerHTML = '<strong role="alert">hydrate boom</strong>';
  const serverFallback = container.querySelector("strong");

  function Broken() {
    throw new Error("hydrate boom");
  }

  hydrate(
    createElement(
      ErrorBoundary,
      {
        fallback: ({ error }) => createElement("strong", { role: "alert" }, errorMessage(error)),
      },
      createElement(Broken, null),
    ),
    container,
  );

  assert.equal(container.querySelector("strong"), serverFallback);
  assert.equal(container.textContent, "hydrate boom");
});

test("hydrate rejects tag mismatches without changing existing DOM", () => {
  const { container } = createContainer();
  container.innerHTML = "<span>Count: 0</span>";

  assert.throws(
    () => hydrate(createElement("button", { type: "button" }, "Count: 0"), container),
    /expected <button>.*found <span>/,
  );
  assert.equal(container.innerHTML, "<span>Count: 0</span>");
});

test("hydrate rejects attribute mismatches", () => {
  const { container } = createContainer();
  container.innerHTML = '<button type="submit">Save</button>';

  assert.throws(
    () => hydrate(createElement("button", { type: "button" }, "Save"), container),
    /attribute mismatch for "type"/,
  );
});
