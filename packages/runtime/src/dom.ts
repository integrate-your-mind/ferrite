export * from "./dom-base.js";

import { __normalizeAttributeChild, type Child, type Component } from "./index.js";
import {
  hydrate as baseHydrate,
  hydrateClientReference as baseHydrateClientReference,
  mount as baseMount,
  type ClientReferenceRegistration,
  type RootHandle,
} from "./dom-base.js";

export function mount(child: Child, container: Element): RootHandle {
  return normalizedRoot(baseMount(__normalizeAttributeChild(child), container));
}

export function hydrate(child: Child, container: Element): RootHandle {
  return normalizedRoot(baseHydrate(__normalizeAttributeChild(child), container));
}

export function hydrateClientReference(
  registration: ClientReferenceRegistration,
  root: ParentNode = globalThis.document,
): RootHandle[] {
  const component = registration.component;
  const normalizedComponent: Component<Record<string, unknown>> = (props) => {
    const rendered = component(props);
    return isPromiseLike(rendered)
      ? rendered.then(__normalizeAttributeChild)
      : __normalizeAttributeChild(rendered);
  };
  return baseHydrateClientReference(
    {
      ...registration,
      component: normalizedComponent,
    },
    root,
  ).map(normalizedRoot);
}

function normalizedRoot(root: RootHandle): RootHandle {
  return {
    update(nextChild) {
      root.update(__normalizeAttributeChild(nextChild));
    },
    unmount() {
      root.unmount();
    },
  };
}

function isPromiseLike(value: unknown): value is Promise<Child> {
  return Boolean(value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function");
}
