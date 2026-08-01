---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/conformance': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Let a deployment register its own EXTERNAL TOOLS into the sidebar, opened already scoped to the
workspace through deployment-declared custom metadata fields.

Two new data-only `registerAppModule` slots, which only mean anything together:

- **`externalTools`** — a deployment's own web applications (a map editor, an asset pipeline, an
  admin console) in a new "External tools" sidebar section and the command palette. A tool declares
  a RESOLVER, `(context) => url`, not a link: the context carries the acting user, the open
  workspace and that workspace's custom metadata, so clicking lands on the right state rather than
  the tool's front door. That is the whole point — a static bookmark needs no registration.
- **`workspaceMetadataFields`** — the custom fields the resolver reads. Declared in CODE (so a
  deployment adds, renames and retires them with no migration); the VALUES are per workspace, typed
  in on a new Metadata tab of Workspace settings and persisted in a `metadata` JSON column on the
  workspace settings row, mirrored across D1 and Postgres.

The worked example is `deploy/frontend`'s `acme:security` module: a `gameId` field, and a map editor
that opens on that game.

Four decisions worth knowing when reading this:

- **A tool that cannot resolve stays LISTED and explains itself on click**, with `missing-metadata`
  (naming the unfilled fields), `unresolved`, `resolver-failed` and `unsafe-url` as four separate
  causes. Hiding it would make an unconfigured workspace look identical to a deployment that never
  registered the tool — and the person reading the sidebar is usually the one who can fix it.
- **The resolved URL must be `http(s)`.** It reaches `window.open`, so a `javascript:` URL from a
  mis-built resolver would execute in the SPA's own origin; the scheme allow-list is a boundary,
  not hygiene. Values are operator-typed, so a resolver sets them as query parameters or encoded
  path segments and never builds the ORIGIN from one — a value like `evil.com/x?a=` spliced into a
  host resolves to somebody else's site and still passes the allow-list.
- **Resolution is TOTAL: a resolver that throws costs its own item and nothing else.** Registered
  tools are projected inside the computed the sidebar, the command palette and the board toolbar
  all render from, so an uncaught throw in a deployment's own resolver would blank all three at
  once. It is caught, reported as `resolver-failed` and the cause logged.
- **The metadata bag is REPLACED wholesale on save, and a cleared field drops its key** rather than
  storing `''` — otherwise "nobody filled this in" and "somebody entered nothing" both resolve to a
  tool URL with an empty parameter. The editor carries any key it does not render back into the
  patch, so a value written under a retired field survives an unrelated save.

The backend deliberately validates only the SHAPE of the bag (identifier-shaped keys, bounded values
and entry count), never the field list: the definitions are code-shipped, so a server-side list would
disagree with the app the moment either side is deployed alone. The key pattern bars a leading `_`,
which keeps `__proto__` out — but `constructor` and `toString` are legal field keys, so every read of
the bag goes through `metadataValue` / `toMetadataBag` and an unfilled field named after an
`Object.prototype` member reads `undefined` rather than an inherited function.
