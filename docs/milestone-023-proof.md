# Milestone 023 Proof: Server Suspense and Render Streams

## What Changed

- Added public `Suspense` and async component return typing to `@ferrite/runtime`.
- Added `RenderStreamPacket` and stream chunk types to the JS facade.
- Reworked `@ferrite/runtime/server` rendering so final SSR awaits async child components, while stream SSR renders `Suspense` fallbacks in the shell and records resolved chunks.
- Added `renderPageModuleToStreamPacket` and `renderDocumentModuleToStreamPacket`.
- Added `--stream` and `--document-stream` modes to the TSX page executor.
- Added Rust `render-stream` decoding in `ferrite-ssr`, producing ordered shell/chunk HTML parts.
- Added `PageRenderer::render_page_to_stream_parts()` and `PageRenderer::render_document_to_stream_parts()`.
- Added an example `/stream-demo` route using `Suspense` and an async child component.
- Updated README and architecture docs to move the roadmap beyond this milestone.

## Why

Ferrite needs an async server rendering primitive before route-level loading/error conventions or a native/WASM server boundary are meaningful. This milestone establishes a typed and versioned contract:

- `render-packet` remains the final HTML render path.
- `render-stream` carries a shell plus ordered chunks.
- `Suspense` is the boundary that decides whether async child work becomes final HTML or a fallback shell with a deferred replacement chunk.

## Verification

- `pnpm --filter @ferrite/runtime typecheck`
- `pnpm --filter @ferrite/runtime test`
- `cargo test -p ferrite-ssr -p ferrite-page-renderer`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Normal path: final server render awaits async child components outside `Suspense`.
- Stream path: `Suspense` emits fallback shell HTML plus a resolved chunk.
- Ready path: synchronous `Suspense` children stay in the shell and produce no chunks.
- Failure path: async `Suspense` fallbacks reject because stream fallbacks must be immediately renderable.
- DOM path: ready `Suspense` is transparent; async client components fail with a direct error.
- Rust path: stream packets render to ordered parts, concatenate through the compatibility renderer, and reject invalid stream chunk ids.
- Process path: page-renderer invokes `--stream` and `--document-stream` and renders returned packets into HTML parts.
- Example path: `/stream-demo` typechecks as an async TSX route, emits a `render-stream` packet through `render-page.mjs --stream`, renders fallback plus replacement chunk through `ferrite render`, and builds static output with the resolved async content.

## Not Yet Proven

- Dev and production static output still use final render output by default; they do not perform chunked HTTP transfer yet.
- The browser runtime can receive replacement chunk scripts in rendered stream parts, but client-side async component rendering is intentionally not implemented.
