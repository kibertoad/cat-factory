# `@cat-factory/app` — Frontend (Nuxt layer)

The user-facing app, packaged as a **reusable Nuxt 4 layer**: a single-page app
that runs entirely in the browser and renders the architecture board, drives agent
pipelines, and reflects live execution. A deployment consumes it via
`extends: ['@cat-factory/app']` (see [`deploy/frontend`](../../deploy/frontend)).
It talks to the [backend Worker](../../backend/README.md) over REST and a single
WebSocket, sharing wire types from
[`@cat-factory/contracts`](../../backend/packages/contracts).

The SPA source lives under `app/` (the Nuxt srcDir).

## Table of contents

- [What it is](#what-it-is)
- [Tech stack](#tech-stack)
- [Layout](#layout)
- [Key UI surfaces](#key-ui-surfaces)
- [Develop & test](#develop--test)

## What it is

A spatial planning surface. You lay out a system as a **board** of frames
(services), modules and tasks on a [Vue Flow](https://vueflow.dev) canvas, wire up
dependencies, attach requirements, and apply **agent pipelines** to blocks.
Execution streams back in real time — step/subtask progress bars, decision
prompts, failures with retry — so the canvas doubles as a live dashboard.

It is a thin client: there is **no business logic here**. Every mutation calls the
Worker API and the stores hydrate from server snapshots and live updates pushed
over the WebSocket. How that sync works is written up in
[`app/docs/architecture.md`](./app/docs/architecture.md).

## Tech stack

- **Nuxt 4 / Vue 3** SPA — single route (`pages/index.vue`).
- **Pinia** (+ `pinia-plugin-persistedstate`) — feature stores.
- **Vue Flow** (`core`, `background`, `controls`, `node-resizer`) — the canvas.
- **Nuxt UI** + Tailwind — components and styling.
- **VueUse** — composable utilities.
- Lint/format via **oxlint** + **oxfmt**; tests via **vitest** + **happy-dom**.

## Layout

| Path              | Contents                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.vue`         | Root; wraps the page in `AuthGate`.                                                                                                                   |
| `pages/index.vue` | The only route — mounts the sidebar, canvas, toolbar, inspector, focus view, and all modals.                                                          |
| `components/`     | UI grouped by area (see [Key UI surfaces](#key-ui-surfaces)).                                                                                         |
| `composables/`    | `useApi` (typed client), `useWorkspaceStream` (WebSocket sync), `useBlockDrag`, `useBlockQueries`, `useBoardFlow`, `useSemanticZoom`, `useDepLabels`. |
| `stores/`         | Pinia stores, one per feature domain.                                                                                                                 |
| `types/`          | TypeScript domain unions (`domain.ts`) and wire types mirroring the contracts.                                                                        |
| `utils/`          | Small pure helpers.                                                                                                                                   |

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

> Building/deploying the static site is covered in the deployment docs — see the
> [top-level README → Deployment](../../README.md#deployment) and
> [`deploy/frontend/README.md`](../../deploy/frontend/README.md).
