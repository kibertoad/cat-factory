# cat-factory — Frontend (Nuxt SPA)

The user-facing app: a **Nuxt 4 single-page app** (`ssr: false`) that renders the
architecture board, drives agent pipelines, and reflects live execution. It talks
to the [backend Worker](../backend/README.md) over REST and a single WebSocket,
sharing wire types from [`@cat-factory/contracts`](../backend/packages/contracts).

## Table of contents

- [What it is](#what-it-is)
- [Tech stack](#tech-stack)
- [Layout](#layout)
- [State & data flow](#state--data-flow)
- [Key UI surfaces](#key-ui-surfaces)
- [Develop & test](#develop--test)

## What it is

A spatial planning surface. You lay out a system as a **board** of frames
(services), modules and tasks on a [Vue Flow](https://vueflow.dev) canvas, wire up
dependencies, attach requirements, and apply **agent pipelines** to blocks.
Execution streams back in real time — step/subtask progress bars, decision
prompts, failures with retry — so the canvas doubles as a live dashboard.

It is a thin client: there is **no business logic here**. Every mutation calls the
Worker API and the stores hydrate from server snapshots + pushed events. The SPA
is static (`nuxt generate`) and the backend URL is baked in at build time via
`NUXT_PUBLIC_API_BASE`.

## Tech stack

- **Nuxt 4 / Vue 3** (`ssr: false`) — single route (`pages/index.vue`).
- **Pinia** (+ `pinia-plugin-persistedstate`) — feature stores.
- **Vue Flow** (`core`, `background`, `controls`, `minimap`, `node-resizer`) — the canvas.
- **Nuxt UI** + Tailwind — components and styling.
- **VueUse** — composable utilities.
- Lint/format via **oxlint** + **oxfmt**; tests via **vitest** + **happy-dom**.

## Layout

| Path | Contents |
| --- | --- |
| `app.vue` | Root; wraps the page in `AuthGate`. |
| `pages/index.vue` | The only route — mounts the sidebar, canvas, toolbar, inspector, focus view, and all modals. |
| `components/` | UI grouped by area (see [Key UI surfaces](#key-ui-surfaces)). |
| `composables/` | `useApi` (typed client), `useWorkspaceStream` (WebSocket sync), `useBlockDrag`, `useBlockQueries`, `useBoardFlow`, `useSemanticZoom`, `useDepLabels`. |
| `stores/` | Pinia stores, one per feature domain. |
| `types/` | TypeScript domain unions (`domain.ts`) and wire types mirroring the contracts. |
| `utils/` | Small pure helpers. |

## State & data flow

```
REST (useApi)  ─────────────▶  Worker  ─────────────▶  D1
   ▲                                                    │
   │ mutations                                          │ persisted transition
stores (Pinia)  ◀── patch ──  useWorkspaceStream  ◀── WebSocket push (events hub)
```

- **Read path:** `workspace` store loads the full snapshot and fans it into
  `board`, `pipelines`, `execution`, `spend`, etc.
- **Write path:** components call `useApi` → Worker; the response (or a pushed
  event) patches the relevant store. No optimistic business logic.
- **Live path:** `useWorkspaceStream` opens one WebSocket to
  `GET /workspaces/:ws/events?token=…`, patches `execution` / `agentRuns` /
  `board` as events arrive, and refreshes on reconnect to reconcile anything
  missed.

Notable stores: `workspace`, `accounts`, `auth`, `board`, `ui`, `pipelines`,
`agents`, `execution`, `agentRuns`, `models`, `github`, `bootstrap`, `documents`,
`tasks`, `requirements`, `scenarios`, `fragments` (built-in catalog),
`fragmentLibrary` (tenant tiers + sources), `spend`.

## Key UI surfaces

- **Board canvas** (`components/board`) — `BoardCanvas` + `nodes/` (`BlockNode`,
  `ModuleFrame`, `TaskCard`), dependency edges, the per-block `AgentFailureCard` /
  `AgentStopButton`, and a deep-zoom `focus/BlockFocusView`.
- **Sidebar & chrome** (`components/layout`) — board/account switchers, palettes
  entry points, the `SpendWarningBanner`, and the toolbar (zoom, LOD, decision
  queue).
- **Palettes** (`components/palettes`) — drag blocks, pipelines and agents onto
  the board.
- **Inspector** (`components/panels` + `panels/inspector`) — per-block tabs:
  structure, dependencies, model + fragment picker, live execution, and linked
  docs/issues/scenarios. Decisions resolve via `DecisionModal`.
- **Pipeline builder** (`components/pipeline`) — assemble/edit agent chains and
  watch `PipelineProgress`.
- **Integrations** — modals/panels for `github`, `bootstrap`, `documents`,
  `tasks`, `requirements` (review), `scenarios` (acceptance), and `fragments`
  (the prompt-fragment library).
- **Auth** (`components/auth`) — `AuthGate` / `LoginScreen` / `UserMenu`; the app
  is gated when the backend requires sign-in.

## Develop & test

```bash
pnpm install
pnpm dev          # Nuxt dev server (expects the Worker running; set NUXT_PUBLIC_API_BASE)
pnpm test         # vitest
pnpm typecheck    # nuxt typecheck
pnpm lint         # oxlint + oxfmt --check
```

> Build/deploy of the static site is part of the setup/deployment docs, which are
> being reworked — see the [top-level README](../README.md#deployment).
