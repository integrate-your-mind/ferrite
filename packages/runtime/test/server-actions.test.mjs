import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "../dist/index.js";
import { collectServerActionsFromPageModule, createServerAction, renderPageModule } from "../dist/server.js";

function createSaveAction(id = "app/posts/[id]/page.tsx#savePost") {
  return createServerAction({
    id,
    routePattern: "/posts/[id]",
    async run({ form, routePath }) {
      return { ok: true, routePath, title: form.title };
    },
  });
}

function createDeferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

test("server actions inherit the active route pattern while rendering", async () => {
  const page = {
    default() {
      const savePost = createServerAction({
        id: "app/posts/[id]/page.tsx#saveInlinePost",
        async run({ form, routePath }) {
          return { ok: true, routePath, title: form.title };
        },
      });

      return createElement("form", { action: savePost }, createElement("input", { name: "title" }));
    },
  };

  const rendered = await renderPageModule(page, {}, [], {}, { routePath: "/posts/abc", routePattern: "/posts/[id]" });

  assert.equal(rendered.kind, "element");
  assert.equal(rendered.tag, "form");
  assert.deepEqual(rendered.children[0], {
    kind: "element",
    tag: "input",
    props: {
      type: "hidden",
      name: "__ferrite_action",
      value: "app/posts/[id]/page.tsx#saveInlinePost",
    },
    children: [],
  });
});

test("server action manifest collection records route-scoped form actions without running them", async () => {
  let actionRuns = 0;
  const page = {
    default() {
      const savePost = createServerAction({
        id: "app/posts/[id]/page.tsx#saveInlinePost",
        async run() {
          actionRuns += 1;
          return { ok: true };
        },
      });

      return createElement("form", { action: savePost }, createElement("button", { type: "submit" }, "Save"));
    },
  };

  const manifest = await collectServerActionsFromPageModule(page, {}, [], {}, {
    routePath: "/posts/abc",
    routePattern: "/posts/[id]",
  });

  assert.equal(actionRuns, 0);
  assert.deepEqual(manifest, {
    routePath: "/posts/abc",
    routePattern: "/posts/[id]",
    actions: [
      {
        ferrite: "server-action-reference",
        version: 1,
        id: "app/posts/[id]/page.tsx#saveInlinePost",
        routePattern: "/posts/[id]",
        url: "/_ferrite/action",
        bound: {},
      },
    ],
  });
});

test("server actions require an explicit route pattern outside a render context", () => {
  assert.throws(
    () =>
      createServerAction({
        id: "app/posts/[id]/page.tsx#saveDetachedPost",
        async run() {
          return { ok: true };
        },
      }),
    /requires a routePattern/,
  );
});

test("parallel async renders keep route-scoped action context isolated", async () => {
  const firstGate = createDeferred();
  const secondGate = createDeferred();
  const createAsyncPage = (id, gate) => ({
    async default() {
      await gate.promise;
      const savePost = createServerAction({
        id,
        async run({ routePath }) {
          return { routePath };
        },
      });

      return createElement("form", { action: savePost }, createElement("button", { type: "submit" }, "Save"));
    },
  });

  const firstRender = renderPageModule(
    createAsyncPage("app/first/page.tsx#savePost", firstGate),
    {},
    [],
    {},
    { routePath: "/first", routePattern: "/first" },
  );
  const secondRender = renderPageModule(
    createAsyncPage("app/second/page.tsx#savePost", secondGate),
    {},
    [],
    {},
    { routePath: "/second", routePattern: "/second" },
  );

  firstGate.resolve();
  secondGate.resolve();
  const [first, second] = await Promise.all([firstRender, secondRender]);

  assert.equal(first.kind, "element");
  assert.equal(second.kind, "element");
  assert.equal(first.children[0].props.value, "app/first/page.tsx#savePost");
  assert.equal(first.children[1].props.value, "/first");
  assert.equal(second.children[0].props.value, "app/second/page.tsx#savePost");
  assert.equal(second.children[1].props.value, "/second");
});

test("server render serializes server action forms to POST metadata", async () => {
  const savePost = createSaveAction();
  const page = {
    default() {
      return createElement(
        "form",
        { action: savePost, className: "editor" },
        createElement("input", { name: "title", defaultValue: "Draft" }),
        createElement("button", { type: "submit" }, "Save"),
      );
    },
  };

  assert.deepEqual(
    await renderPageModule(page, {}, [], {}, { routePath: "/posts/abc", routePattern: "/posts/[id]" }),
    {
      kind: "element",
      tag: "form",
      props: {
        action: "/_ferrite/action",
        class: "editor",
        method: "post",
      },
      children: [
        {
          kind: "element",
          tag: "input",
          props: {
            type: "hidden",
            name: "__ferrite_action",
            value: "app/posts/[id]/page.tsx#savePost",
          },
          children: [],
        },
        {
          kind: "element",
          tag: "input",
          props: {
            type: "hidden",
            name: "__ferrite_route",
            value: "/posts/abc",
          },
          children: [],
        },
        {
          kind: "element",
          tag: "input",
          props: {
            name: "title",
            defaultValue: "Draft",
          },
          children: [],
        },
        {
          kind: "element",
          tag: "button",
          props: {
            type: "submit",
          },
          children: [{ kind: "text", value: "Save" }],
        },
      ],
    },
  );
});

test("server action forms reject conflicting methods and reserved hidden fields", async () => {
  const savePost = createSaveAction();

  await assert.rejects(
    () =>
      renderPageModule(
        {
          default() {
            return createElement("form", { action: savePost, method: "get" }, "Save");
          },
        },
        {},
        [],
        {},
        { routePath: "/posts/abc", routePattern: "/posts/[id]" },
      ),
    /server action forms must use method="post"/,
  );

  await assert.rejects(
    () =>
      renderPageModule(
        {
          default() {
            return createElement(
              "form",
              { action: savePost },
              createElement("input", { type: "hidden", name: "__ferrite_action", value: "other" }),
            );
          },
        },
        {},
        [],
        {},
        { routePath: "/posts/abc", routePattern: "/posts/[id]" },
      ),
    /reserved Ferrite server action field/,
  );
});

test("server actions are only serializable as form action props", async () => {
  const savePost = createSaveAction();

  await assert.rejects(
    () =>
      renderPageModule(
        {
          default() {
            return createElement("button", { onClick: savePost }, "Save");
          },
        },
        {},
        [],
        {},
        { routePath: "/posts/abc", routePattern: "/posts/[id]" },
      ),
    /server actions can only be used as <form action>/,
  );

  await assert.rejects(
    () =>
      renderPageModule(
        {
          default() {
            return createElement("div", { action: savePost }, "Save");
          },
        },
        {},
        [],
        {},
        { routePath: "/posts/abc", routePattern: "/posts/[id]" },
      ),
    /server actions can only be used as <form action>/,
  );
});

test("server action ids must be unique in one render", async () => {
  const first = createSaveAction();
  const second = createSaveAction();

  await assert.rejects(
    () =>
      renderPageModule(
        {
          default() {
            return [
              createElement("form", { action: first }, "First"),
              createElement("form", { action: second }, "Second"),
            ];
          },
        },
        {},
        [],
        {},
        { routePath: "/posts/abc", routePattern: "/posts/[id]" },
      ),
    /duplicate Ferrite server action id/,
  );
});

test("non-action form actions keep primitive serialization", async () => {
  const page = {
    default() {
      return createElement("form", { action: "/search", method: "get" }, createElement("input", { name: "q" }));
    },
  };

  assert.deepEqual(await renderPageModule(page), {
    kind: "element",
    tag: "form",
    props: {
      action: "/search",
      method: "get",
    },
    children: [
      {
        kind: "element",
        tag: "input",
        props: {
          name: "q",
        },
        children: [],
      },
    ],
  });
});
