# React compatibility

Ferrite is **not a drop-in React replacement**. It provides a React-like
TypeScript authoring model over a separate runtime, renderer, hydration
contract, and Rust-owned server protocol. A React application should be
evaluated surface by surface before migration.

This matrix was reviewed against the current official React documentation on
2026-07-28 and the Ferrite source and tests at the repository head. The labels
mean:

- **Supported subset**: the named behavior has direct source and test coverage.
- **Partial**: useful behavior exists, but important React semantics differ.
- **Different**: Ferrite intentionally exposes a separate contract.
- **Not implemented**: no compatible public Ferrite API exists.
- **Experimental**: the surface exists but is not a stable compatibility claim.

## Compatibility matrix

| Surface | React contract | Ferrite status | Evidence and important differences |
| --- | --- | --- | --- |
| JSX and function components | JSX produces React elements; components are called by React and must remain pure. | **Partial** | Ferrite provides its own `jsx`/`jsxs`, `createElement`, function components, keys, and fragments in [`packages/runtime/src`](../packages/runtime/src). The element symbol, child types, component identity, and renderer are Ferrite-specific. |
| Intrinsic element typing | React's TypeScript declarations provide element-specific attributes, event types, and ref types. | **Partial** | Ferrite's JSX runtime currently accepts `Record<string, unknown>` for every intrinsic element. Runtime validation exists for attributes and events, but React's compile-time HTML/SVG/event type coverage is not present. |
| Children and fragments | React accepts a broad `ReactNode` model and treats children as opaque. | **Partial** | Ferrite supports primitives, VNodes, arrays, fragments, and promises at the type level. DOM rendering rejects async children; the server renderer handles a bounded async subset. React portals and React element objects are not accepted. |
| State | `useState` queues updater functions, batches event updates, and may skip equal state with `Object.is`. | **Partial** | Ferrite supports lazy initialization and functional updates. Urgent setters render synchronously one at a time, do not implement React event batching, and do not perform the same equality bailout. |
| Reducers and context | `useReducer`, `createContext`, and `useContext` participate in React's render and propagation model. | **Not implemented** | Ferrite does not export these APIs. React providers and consumers cannot be moved unchanged. |
| Effects | `useEffect` runs after commit with React-defined dependency and cleanup behavior; development Strict Mode adds stress cycles. | **Partial** | Ferrite supports dependency arrays and cleanup for `useEffect` and `useLayoutEffect`, but currently flushes both synchronously after commit and has no React Strict Mode contract. |
| Refs | React supports ref objects, DOM refs, callback refs, and `ref` as a prop in React 19. | **Partial** | Ferrite exports stable `useRef` objects. It does not implement React DOM/callback ref attachment or the React 19 `ref` prop contract. |
| DOM events | React exposes synthetic events, normalized event names, propagation, and `Capture` phase props. | **Partial** | Ferrite attaches native listeners directly. It supports existing native-style props plus the verified `onDoubleClick` to `dblclick` alias and native capture-phase props such as `onClickCapture`. It does not implement React's synthetic event layer or `onChange` normalization. |
| Transitions and Suspense | React coordinates transitions, Suspense boundaries, interruption, and recovery across the renderer. | **Experimental** | Ferrite has `startTransition`, `useTransition`, `useDeferredValue`, and server streaming boundaries, but scheduling and recovery are Ferrite contracts rather than React concurrency compatibility. |
| Client hydration | `hydrateRoot` expects equivalent server/client output, reports recoverable errors, and may recover mismatches. | **Different** | Ferrite `hydrate` and client-reference hydration consume existing DOM with strict structural checks and fail closed on mismatches. There is no `hydrateRoot` object, React error callbacks, or general React tree hydration. |
| Server rendering | React DOM Server exposes streaming and static rendering APIs with React element semantics. | **Different** | Ferrite has its own escaped HTML renderer, render packets, streaming packets, document rendering, and static artifact pipeline. React server-rendering entry points and React elements are not accepted. |
| Server serialization | React Server Functions and RSC use React's serializable value and reference contracts. | **Different** | Ferrite uses versioned Rust-owned packets and a fail-closed JSON-like client-reference serializer. Functions, class instances, symbols, non-finite numbers, and unsupported props are rejected rather than treated as React references. |
| React ecosystem packages | React packages commonly depend on React elements, context, hooks, reconciler behavior, or `react-dom`. | **Not implemented** | Packages that depend on React runtime identity or internals are not compatible. Framework-agnostic browser libraries may work only when exercised through Ferrite and independently tested. |

## Event compatibility slice

The previous event-prop conversion lowercased every name after `on`:

- `onDoubleClick` became `doubleclick`, while browsers dispatch `dblclick`.
- `onClickCapture` became `clickcapture`, so no capture listener was installed.

Ferrite now parses the React-facing names into an explicit native event binding:

- `onDoubleClick` maps to `dblclick`.
- a trailing `Capture` selects the native capture phase;
- `onGotPointerCapture` and `onLostPointerCapture` remain native event names
  rather than being mistaken for phase suffixes;
- capture props with non-function handlers fail closed without mutating the
  current tree;
- existing native-style props such as `onClick` and `onDblClick` continue to
  work.

Coverage lives in
[`packages/runtime/test/dom.test.mjs`](../packages/runtime/test/dom.test.mjs).
This slice improves prop-name compatibility only. Event objects remain native
DOM events, listeners remain attached per element, and React's delegated
synthetic event behavior is outside this claim.

## Migration guidance

1. Treat `.tsx` syntax compatibility separately from runtime compatibility.
2. Inventory every imported React API and every package that imports React or
   React DOM.
3. Migrate leaf components that use props, JSX, local state, and covered native
   events first.
4. Rewrite context, reducer, ref, effect-timing, synthetic-event, hydration,
   and server-component dependencies against explicit Ferrite contracts.
5. Keep React for any application whose required surface is marked
   **Not implemented** or whose **Partial** differences are not covered by
   application-level tests.

No performance, ecosystem, or automatic migration claim is implied by this
matrix.

## Official React references

- [Writing markup with JSX](https://react.dev/learn/writing-markup-with-jsx)
- [`useState`](https://react.dev/reference/react/useState) and
  [queueing state updates](https://react.dev/learn/queueing-a-series-of-state-updates)
- [Responding to events](https://react.dev/learn/responding-to-events) and
  [common DOM event props](https://react.dev/reference/react-dom/components/common)
- [`useContext`](https://react.dev/reference/react/useContext) and
  [`createContext`](https://react.dev/reference/react/createContext)
- [`useEffect`](https://react.dev/reference/react/useEffect)
- [`useRef`](https://react.dev/reference/react/useRef) and
  [React 19 ref changes](https://react.dev/blog/2024/12/05/react-19)
- [`hydrateRoot`](https://react.dev/reference/react-dom/client/hydrateRoot)
- [React DOM server APIs](https://react.dev/reference/react-dom/server)
- [Server Function serialization](https://react.dev/reference/rsc/use-server)
