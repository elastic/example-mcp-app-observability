# UI harness

Standalone Vite dev environment for iterating on view styles without Claude
Desktop or a live Kibana.

## Run

```bash
npm run harness
```

Opens at <http://localhost:5371/>. Hot-module reload is on — edit any view
source or `src/shared/*` and the preview updates without a full refresh.

## How it works

Vite aliases `@shared/use-app` to `harness/mock-use-app.tsx`, a drop-in hook
that delivers a fixture payload directly to the view's `ontoolresult`
handler instead of round-tripping through `window.parent.postMessage`. The
views themselves are unmodified.

## Sidebar

- **View** — the six views bundled by `scripts/build-views.js`.
- **State** — named fixtures from `harness/fixtures/<view>.ts`. Switching
  re-dispatches the payload; the view sees it as a fresh tool result.
- **Theme** — flips between the DS tokens' dark and light maps.
- **Accessibility** — runs `axe-core` (WCAG 2 AA + best practices) against
  the view container. Violations land in a floating panel.

## Adding a fixture

1. Pick (or create) `harness/fixtures/<view>.ts`.
2. Call `fixture(label, payload)` and add it to the `FixtureSet`; the key
   is what the sidebar uses to identify the state.
3. The payload must match the interface the view parses via
   `parseToolResult<T>` — see each view's `App.tsx` for the shape.

No wiring is needed — the sidebar rebuilds from `harness/fixtures/index.ts`
on every change.
